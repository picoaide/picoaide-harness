// Package skillseed 下发**随服务端镜像一起发布**的内置技能。
//
// 定位与 internal/clientrelease 完全同构：镜像层里放一份资产目录（Dockerfile
// 的 ENV 固定为 /opt/picoaide/skills，可用 PICOAI_SKILL_SEED_DIR 覆盖），服务端
// 把那个目录直接对外提供 —— 目录里的文件随镜像升级而更新，正是「技能内置到
// 服务端」要的语义。
//
// 与市场/组织技能的关系：那两条通路的内容存在数据库里（上传 → 审核 → 授权），
// 本包的内容存在镜像里（随版本走、对所有登录员工可见）。因此这里没有「授权」
// 这一步，但**仍要求登录**（BearerAuth，与能力中心同口径）：未登录时连
// 「平台内置了哪些技能」都不该被枚举。
//
// 客户端侧零新概念：能力中心用既有的技能安装链路（下载 → sha256 对照 → 整树
// 安全解包 → `<dshHome>/skills`）按需安装 —— 不需要管理员权限，也不自动安装。
//
// 三条硬约束（都会被测试钉住）：
//
//  1. **自己生成 tar.gz**，不依赖外部 tar 命令：条目按名字排序、时间戳归零，
//     因此同一份源目录永远产出同一串字节（sha256 才是可信的完整性凭据）。
//  2. 包内路径防穿越：每个条目都过 archiveutil.NormalizePath（拒绝绝对路径与
//     `..`），并且打包后再用 archiveutil.Validate 复核一遍 —— 用的是与上传
//     通路**同一份**约束常量与校验，不另立一套数字。
//  3. 内容必须通过服务端**既有的** manifest 校验（skillmanifest.Parse），
//     与「管理员上传一个技能包」走完全相同的规则；不合格的内置技能在启动
//     扫描时就被丢掉并记录原因，而不是等员工安装时才发现。
package skillseed

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// 内置技能资产的镜像内目录，由 Dockerfile 的 ENV 固定（/opt/picoaide/skills）。
// 服务端直接读它 —— 镜像层里的文件随镜像升级而更新，与 clientrelease.Dir 同一范式。
var Dir = func() string {
	if v := os.Getenv("PICOAI_SKILL_SEED_DIR"); v != "" {
		return v
	}
	return "/opt/picoaide/skills"
}()

const (
	// SkillFile 技能包的入口文件：必须在目录根部（与上传通路同一个要求）。
	SkillFile = "SKILL.md"
	// manifestPreviewBytes 交给 YAML 解析器的 SKILL.md 上限（与 skillmanifest
	// 的既有上限同源；超限的 SKILL.md 会被 Parse 拒掉）。
	manifestPreviewBytes = 128 << 10
	// provenanceDir 安装器专用溯源目录：包内自带即可伪造归属，因此内置技能
	// 目录里出现它就拒绝（与 skillmanifest.checkProvenance 同一口径）。
	provenanceDir = ".picoaide"
)

// limits 是打包与校验用的边界。**默认值直接取 archiveutil 的既有常量**
// （16 MiB 原始 / 64 MiB 解包 / 10000 条目）—— 全仓只有一份数字，不在这里
// 另抄一套。作为变量存在只为让测试能把上限临时收窄（否则要造 10001 个文件
// 或一个 64 MiB 的样本才能证明闸门真的在）。
var limits = archiveutil.DefaultLimits(SkillFile)

// packEntryName 是打包侧**唯一**的一道路径闸：把一个相对路径归一化成包内
// 条目名。
//
// 归一化走 archiveutil.NormalizePath（与上传通路同一个实现）：
//   - 绝对路径（`/x`、`\x`、`C:\x`）→ 拒绝；
//   - 任何 `..` 段 → 拒绝；
//   - `.` / 空段折叠掉。
//
// 返回 skip=true 表示这是包根自身（`./`），不产出条目。
// 另外拒绝 .picoaide/（安装器专用的溯源目录）。
func packEntryName(rel string) (name string, skip bool, err error) {
	clean, nerr := archiveutil.NormalizePath(filepath.ToSlash(rel))
	if nerr != nil {
		return "", false, fmt.Errorf("包内路径不安全（%s）: %w", rel, nerr)
	}
	if clean == "" {
		return "", true, nil
	}
	if clean == provenanceDir || strings.HasPrefix(clean, provenanceDir+"/") {
		return "", false, fmt.Errorf("包内不得包含 %s 目录（安装器专用溯源标记，自带即可伪造归属）", provenanceDir)
	}
	return clean, false, nil
}

// Entry 是清单里的一行（也是打包一次的结果）。
//
// sha256/size 描述的是**打包后的 tar.gz**，与客户端 skill-install 的校验口径
// 一致（客户端对下载到的字节做 sha256，再与 x-skill-checksum 对照）。
type Entry struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Author      string `json:"author"`
	Category    string `json:"category"`
	// SHA256 打包产物的 sha256（小写十六进制），随清单下发。
	SHA256 string `json:"sha256"`
	// Size 打包产物的字节数。
	Size int64 `json:"size"`
	// Files 包内普通文件数（不含目录条目），供运维核对"是不是整目录都进去了"。
	Files int `json:"files"`

	archive []byte
}

// Catalog 是内置技能目录的只读快照。
//
// 扫描 + 打包 + 校验只在第一次访问时做一次（镜像内的资产不会变），结果缓存
// 在内存里 —— 单个技能 88 KiB，全部内置技能加起来也在百 KiB 量级。
type Catalog struct {
	dir string

	mu       sync.RWMutex
	loaded   bool
	entries  []Entry
	byName   map[string]int
	problems []string
}

// New 创建一个指向 dir 的目录快照（此时不读盘）。
func New(dir string) *Catalog {
	return &Catalog{dir: dir}
}

// Dir 返回本快照读取的目录（排查用）。
func (c *Catalog) Dir() string { return c.dir }

// Problems 返回扫描时被跳过的条目及原因（启动日志用：内置资产坏掉必须可见）。
func (c *Catalog) Problems() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]string(nil), c.problems...)
}

// Entries 返回全部可用内置技能的清单行（副本）。
func (c *Catalog) Entries() []Entry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]Entry(nil), c.entries...)
}

// Archive 按名字取打包产物。name 永远只用于**查表**，不参与任何路径拼接，
// 因此 URL 参数不存在穿越面。
func (c *Catalog) Archive(name string) (Entry, []byte, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	i, ok := c.byName[name]
	if !ok {
		return Entry{}, nil, false
	}
	e := c.entries[i]
	return e, e.archive, true
}

// Load 扫描目录并打包全部内置技能。幂等：已加载则直接返回。
//
// 目录不存在时返回 nil（不是错误）：本地 `make build-server` 的二进制旁边没有
// `/opt/picoaide/skills`，此时内置清单为空是正确的，服务端照常启动。
func (c *Catalog) Load() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded {
		return nil
	}
	return c.loadLocked()
}

// Reload 强制重新扫描（运维替换资产目录后免重启；测试也用它）。
func (c *Catalog) Reload() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.loadLocked()
}

func (c *Catalog) loadLocked() error {
	entries := make([]Entry, 0, 4)
	problems := make([]string, 0)
	names, err := os.ReadDir(c.dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		// 资产目录不存在 = 这个部署没有内置技能。不是错误，但要留下痕迹：
		// 「客户端按需安装列表是空的」必须有可解释的原因。
		log.Printf("skillseed: 内置技能目录不存在（%s），内置技能清单为空", c.dir)
	case err != nil:
		return fmt.Errorf("skillseed: 读取内置技能目录 %s: %w", c.dir, err)
	default:
		for _, de := range names {
			if !de.IsDir() {
				continue
			}
			name := de.Name()
			entry, lerr := loadSkill(c.dir, name)
			if lerr != nil {
				problems = append(problems, fmt.Sprintf("%s: %v", name, lerr))
				continue
			}
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	byName := make(map[string]int, len(entries))
	for i, e := range entries {
		byName[e.Name] = i
	}
	c.entries = entries
	c.byName = byName
	c.problems = problems
	c.loaded = true
	return nil
}

// loadSkill 读一个技能目录 → 打包 → 用既有校验复核 → 解析 manifest。
func loadSkill(root, name string) (Entry, error) {
	var zero Entry
	if !skillmanifest.IsAppID(name) {
		return zero, fmt.Errorf("目录名不是合法应用 ID（小写 kebab-case）")
	}
	dir := filepath.Join(root, name)
	archive, files, err := PackDir(dir)
	if err != nil {
		return zero, err
	}
	// 复核：用的是上传通路的同一份约束常量与校验（16MiB 原始 / 64MiB 解包 /
	// 10000 条目 / 根部必须有 SKILL.md）。产出必须能过自己的闸门。
	lim := archiveutil.DefaultLimits(SkillFile)
	sum, err := archiveutil.Validate(archive, lim)
	if err != nil {
		return zero, fmt.Errorf("归档未通过 archiveutil 校验: %w", err)
	}
	entries, skillMD, err := archiveutil.ListContents(archive, lim, manifestPreviewBytes)
	if err != nil {
		return zero, fmt.Errorf("归档条目读取失败: %w", err)
	}
	// manifest 校验：与「管理员上传技能包」完全相同的规则与错误码。
	manifest, err := skillmanifest.Parse(entries, skillMD, name)
	if err != nil {
		return zero, fmt.Errorf("manifest 校验未通过: %w", err)
	}
	return Entry{
		Name:        manifest.AppID,
		Version:     manifest.Version,
		Title:       manifest.Title,
		Description: manifest.Description,
		Author:      manifest.Author,
		Category:    manifest.Category,
		SHA256:      sum,
		Size:        int64(len(archive)),
		Files:       files,
		archive:     archive,
	}, nil
}

// PackDir 把一个技能目录打成确定性的 tar.gz（不依赖外部 tar 命令）。
//
// 确定性：条目按路径排序、mtime 归零、uid/gid 归零、gzip 头不带文件名/时间。
// 于是「同一份源 → 同一串字节 → 同一个 sha256」，客户端拿到的校验和才有意义，
// 也才能用测试钉住「服务端下发的字节 == 员工装到磁盘的字节」。
//
// 安全：条目名过 archiveutil.NormalizePath（拒绝绝对路径与 `..`）；符号链接、
// 硬链接、设备/管道等非普通文件一律拒绝；条目数与解包总量用 archiveutil 的
// 既有常量封顶。返回的第二个值是包内普通文件数。
func PackDir(dir string) ([]byte, int, error) {
	type item struct {
		name string
		dir  bool
		mode fs.FileMode
		data []byte
	}
	items := make([]item, 0, 16)
	total := int64(0)
	files := 0
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == dir {
			return nil
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		// 路径闸在 packEntryName 里（同一份实现，单测直接打它）。
		clean, skip, nerr := packEntryName(rel)
		if nerr != nil {
			// fail-loud：包内出现绝对路径/`..` 说明有人在资产目录里放了不该放
			// 的东西，宁可整条技能不下发。
			return nerr
		}
		if skip {
			return nil
		}
		if len(items) >= limits.MaxEntries {
			return fmt.Errorf("条目数超过上限 %d", limits.MaxEntries)
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			return fmt.Errorf("符号链接不被接受（%s）", clean)
		case d.IsDir():
			items = append(items, item{name: clean + "/", dir: true, mode: 0o755})
		case d.Type().IsRegular():
			data, derr := os.ReadFile(path)
			if derr != nil {
				return derr
			}
			total += int64(len(data))
			if total > limits.MaxUnpackedBytes {
				return fmt.Errorf("解包总量超过上限 %d 字节", limits.MaxUnpackedBytes)
			}
			items = append(items, item{name: clean, mode: 0o644, data: data})
			files++
		default:
			return fmt.Errorf("只接受普通文件与目录（%s 是 %s）", clean, d.Type().String())
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].name < items[j].name })
	hasSkill := false
	for _, it := range items {
		if it.name == SkillFile {
			hasSkill = true
		}
	}
	if !hasSkill {
		return nil, 0, fmt.Errorf("目录根部缺少 %s", SkillFile)
	}
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	// 归零的 gzip 头（Go 在 ModTime 为零时不写时间字段）——确定性的一部分。
	gz.Name = ""
	gz.Comment = ""
	gz.ModTime = time.Time{}
	tw := tar.NewWriter(gz)
	for _, it := range items {
		hdr := &tar.Header{
			Name:     it.name,
			Mode:     int64(it.mode.Perm()),
			ModTime:  time.Unix(0, 0).UTC(),
			Uid:      0,
			Gid:      0,
			Uname:    "",
			Gname:    "",
			Typeflag: tar.TypeReg,
		}
		if it.dir {
			hdr.Typeflag = tar.TypeDir
		} else {
			hdr.Size = int64(len(it.data))
		}
		if werr := tw.WriteHeader(hdr); werr != nil {
			return nil, 0, werr
		}
		if !it.dir {
			if _, werr := tw.Write(it.data); werr != nil {
				return nil, 0, werr
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, 0, err
	}
	if err := gz.Close(); err != nil {
		return nil, 0, err
	}
	if buf.Len() > limits.MaxArchiveBytes {
		return nil, 0, fmt.Errorf("归档超过上限 %d 字节", limits.MaxArchiveBytes)
	}
	return buf.Bytes(), files, nil
}

// Handlers 内置技能下发端点（路由声明集中在 internal/router）。
type Handlers struct {
	catalog *Catalog
}

// NewHandlers 构造下发端点。
func NewHandlers(c *Catalog) *Handlers { return &Handlers{catalog: c} }

// Catalog 暴露目录快照（启动日志与测试用）。
func (h *Handlers) Catalog() *Catalog { return h.catalog }

// ListBuiltin 处理 GET /api/client/v2/skills/builtin。
//
// 形状与市场清单一致（`{"skills":[...]}`），值来自镜像内资产 —— 没有数据库
// 往返，也没有授权过滤：内置技能对**所有登录员工**可见。
func (h *Handlers) ListBuiltin(c *gin.Context) {
	if err := h.catalog.Load(); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "内置技能清单读取失败")
		return
	}
	for _, p := range h.catalog.Problems() {
		// 内置资产坏掉必须留下可诊断的痕迹（客户端只会看到它不在清单里）。
		log.Printf("skillseed: 内置技能被跳过 —— %s", p)
	}
	entries := h.catalog.Entries()
	skills := make([]gin.H, 0, len(entries))
	for _, e := range entries {
		skills = append(skills, gin.H{
			"name":        e.Name,
			"version":     e.Version,
			"title":       e.Title,
			"description": e.Description,
			"author":      e.Author,
			"category":    e.Category,
			"sha256":      e.SHA256,
			"size":        e.Size,
			"files":       e.Files,
			"source":      "builtin",
		})
	}
	c.JSON(http.StatusOK, gin.H{"skills": skills})
}

// BuiltinDownload 处理 GET /api/client/v2/skills/builtin/:name/archive。
//
// 响应头与 marketplace/sharedskills 完全一致（`X-Skill-Checksum` /
// `X-Skill-Version`）—— 客户端 skill-install.ts 靠它们做 sha256 对照与版本标记，
// 少了头就"跳过校验"，所以这两个头是契约而不是装饰。
func (h *Handlers) BuiltinDownload(c *gin.Context) {
	if err := h.catalog.Load(); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "内置技能读取失败")
		return
	}
	name := c.Param("name")
	entry, archive, ok := h.catalog.Archive(name)
	if !ok {
		// 不存在与「有但坏了」同响应：不泄露内部诊断信息。
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "内置技能不存在")
		return
	}
	dispName := entry.Name + "-" + entry.Version + ".tar.gz"
	contentType := "application/gzip"
	c.Header("X-Skill-Version", entry.Version)
	c.Header("X-Skill-Checksum", entry.SHA256)
	c.Header("Content-Disposition", "attachment; filename=\""+dispName+"\"")
	c.Data(http.StatusOK, contentType, archive)
}
