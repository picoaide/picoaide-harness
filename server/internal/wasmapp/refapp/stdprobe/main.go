// Command stdprobe 是**只用于生成导入白名单**的第三个探测程序（FIX-31 / 审计 P0-1）：
// 真编译一个"应用真的会写的那种代码"的 Go 程序，让链接器把相应的 WASI 导入带进产物。
//
// 为什么需要它（审计实测的 P0 功能缺陷）：
// 白名单此前由 refapp + wasiprobe 两份程序生成，两者都不渲染模板、也不用 `(*os.File).ReadAt`，
// 于是下列四条符号**不在白名单里**——而它们不是"平台不该支持的能力"，是**合法 Go 应用必然发出**
// 的 WASI 调用（Go 是 §9.1 的 Tier 1 官方语言）：
//
//	sock_accept / sock_shutdown   ← `html/template` 与 `text/template` 的 **Execute（渲染）**
//	fd_pread   / fd_pwrite        ← `(*os.File).ReadAt` / `WriteAt`
//
// 后果：任何"用 html/template 渲染一个 HTML 页面"的应用——本平台最主要的用法（§4.2 R8：
// 静态资源/HTML 编译进 wasm）——上传时就被 `IMPORT_NOT_ALLOWED` 拒，应用根本发不出去。
//
// 除这四条之外，本程序还刻意触碰一批此前没覆盖的常见 std 面（编码/字符串/排序/正则/数学/
// 时间解析/摘要/缓冲 IO/上下文/同步），把"下次又缺一条"的概率压低：白名单是各来源的**并集**，
// 多覆盖一条 std 用法就少一类"照 skill 抄却被拒"的应用。
//
// 白名单的正确语义仍然是**保守超集**（"Go wasip1 运行时可能发出的全部 wasi_snapshot_preview1
// 导入"），红线不靠白名单保证：
//   - 红线 5（不能读宿主文件）由**运行时零 preopen** 保证（§4.3 / §15.1 第 1 条）。零 preopen 下
//     文件操作一律 DENIED，errno 视调用层与路径形态为 EBADF(8) / EPERM(63) / ENOTDIR(54)，
//     **不是 ENOSYS**（审计实测矩阵，2026-09-18 更正——旧注释写 ENOSYS 是错的）；
//   - 红线 4（不能出站）由"**没有任何途径得到一个 socket fd**"保证：preview1 只有
//     `sock_accept` / `sock_recv` / `sock_send` / `sock_shutdown`，**没有** `sock_open` /
//     `sock_bind` / `sock_listen` / `sock_connect` ⇒ 自造不出 socket fd；而 `sock_accept(0..10)`
//     与 `sock_shutdown(3)` 实测全 EBADF(8)，`syscall.Socket` 在 wasip1 上是
//     "Not implemented on wasip1"。所以静态闸门的正确判据是"拒 `sock_open` 这类造 fd 的符号"，
//     不是"拒一切 `sock_*`"（后者会把模板渲染判死，见上）。
//
// ⚠️ 本程序**不是教学样例**（教学样例是 refapp），也**不是**给平台运行的：生成器只编译它、
// 不运行它。为了让"本机原生跑一遍"仍然安全（自测与门禁用例会这么做）：
//   - 文件操作全部落在自建的临时目录里，跑完清理；
//   - 会阻塞（读 stdin）或会终止进程（os.Exit）的调用放在**不可达守卫**后面：条件永假但
//     编译器无法静态证明，因此调用会进产物（导入被保留），真跑时又不会执行。
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	hashfnv "hash/fnv"
	htmltemplate "html/template"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"text/template"
	"time"
	"unicode"
	"unicode/utf8"
)

// guarded 是不可达守卫：条件永假（正常进程的 argv 不可能有上百万个），但编译器无法静态证明，
// 所以分支内的调用不会被死代码消除 ⇒ 对应的 WASI 导入留在产物里，而真跑时不会执行。
func guarded() bool { return len(os.Args) > 1<<20 }

// 包级模板：`New/Parse` 在包初始化期就执行（编译进产物），`Execute` 在 renderPage 里
// —— 触发 sock_accept / sock_shutdown 的正是 **Execute**（审计实测）。
var (
	htmlPage = htmltemplate.Must(htmltemplate.New("page").Funcs(htmltemplate.FuncMap{
		"upper": strings.ToUpper,
	}).Parse(`<h1>{{.User}}</h1>{{if .Items}}<ul>{{range .Items}}<li>{{.}}</li>{{end}}</ul>{{end}}`))

	textPage = template.Must(template.New("text").Parse(`user={{.User}} n={{.Count}}`))
)

// sink 防止"算出来没被用到"的结果被优化掉。
var sink any

func main() {
	dir, err := os.MkdirTemp("", "stdprobe-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "stdprobe: mkdirtemp:", err)
		os.Exit(1) // 只有本机原生跑才可能走到这里（平台上本程序不会被运行）
	}
	defer func() { _ = os.RemoveAll(dir) }()

	page, text, err := renderPage("template", []string{"a", "b"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "stdprobe: render:", err)
		os.Exit(1)
	}
	if err := probeReadAtWriteAt(dir); err != nil {
		fmt.Fprintln(os.Stderr, "stdprobe: ReadAt/WriteAt:", err)
		os.Exit(1)
	}
	if err := probeStdSurface(dir); err != nil {
		fmt.Fprintln(os.Stderr, "stdprobe: std:", err)
		os.Exit(1)
	}
	if err := probeGuarded(); err != nil {
		fmt.Fprintln(os.Stderr, "stdprobe: guarded:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "stdprobe: ok（html %d 字节 / text %q）\n", len(page), text)
}

// renderPage 触发 sock_accept / sock_shutdown：两种模板的 **Execute**（渲染到 bytes.Buffer）。
//
// 为什么渲染会带出 socket 导入：`text/template` 的执行路径牵扯到 Go 运行时的调度/等待面，
// 链接器因此保留了 wasip1 的 sock_accept / sock_shutdown 调用点。这不是应用的错，也不是平台
// 该拒的能力 —— 它只是"Go 编译产物必然带上的一小块运行时"。
func renderPage(user string, items []string) (string, string, error) {
	var hb, tb bytes.Buffer
	if err := htmlPage.Execute(&hb, map[string]any{"User": user, "Items": items}); err != nil {
		return "", "", err
	}
	if err := textPage.Execute(&tb, struct {
		User  string
		Count int
	}{User: user, Count: len(items)}); err != nil {
		return "", "", err
	}
	sink = hb.Len() + tb.Len()
	return hb.String(), tb.String(), nil
}

// probeReadAtWriteAt 触发 fd_pread / fd_pwrite（`(*os.File).ReadAt` / `WriteAt`）。
//
// 平台侧（零 preopen）这些调用一律 DENIED；本机原生跑应当成功（审计实测 errno 是
// EBADF/EPERM/ENOTDIR 一类，不是 ENOSYS）。
func probeReadAtWriteAt(dir string) error {
	path := filepath.Join(dir, "readat.txt")
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	chunks := []string{"hello", " ", "wasi"}
	off := int64(0)
	for _, c := range chunks {
		n, werr := f.WriteAt([]byte(c), off)
		if werr != nil {
			return werr
		}
		off += int64(n)
	}
	if err := f.Sync(); err != nil { // fd_sync
		return err
	}
	buf := make([]byte, off)
	if _, err := f.ReadAt(buf, 0); err != nil {
		return err
	}
	if string(buf) != strings.Join(chunks, "") {
		return fmt.Errorf("ReadAt 结果不符: %q", buf)
	}
	if _, err := f.Stat(); err != nil { // fd_filestat_get
		return err
	}
	if err := f.Truncate(off - 1); err != nil { // fd_filestat_set_size
		return err
	}
	return nil
}

// probeStdSurface 触碰一批"应用真的会写"的 std 面：每多覆盖一条，就少一类
// "照 skill 抄却被 IMPORT_NOT_ALLOWED 拒"的应用。
func probeStdSurface(dir string) error {
	// encoding/json：编解码。
	doc := map[string]any{"user": "zhangwei", "n": 3, "tags": []string{"a", "b"}}
	raw, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	var back struct {
		User string   `json:"user"`
		N    int      `json:"n"`
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(raw, &back); err != nil {
		return err
	}

	// strings / strconv / sort / unicode / utf8。
	line := strings.Join([]string{" b ", "a", "c"}, ",")
	fields := strings.FieldsFunc(line, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	sort.Strings(fields)
	nums := make([]int, 0, len(fields))
	for _, s := range fields {
		n, cerr := strconv.Atoi(strings.TrimSpace(s))
		if cerr != nil {
			n = utf8.RuneCountInString(s)
		}
		nums = append(nums, n)
	}
	sort.Slice(nums, func(i, j int) bool { return nums[i] < nums[j] })
	if !sort.IntsAreSorted(nums) {
		return errors.New("排序结果不是有序的")
	}
	if !utf8.ValidString(line) {
		return errors.New("utf8 校验失败")
	}

	// regexp。
	re := regexp.MustCompile(`^[a-z]+-(\d+)$`)
	if !re.MatchString("item-42") {
		return errors.New("正则未命中")
	}
	if got := re.FindStringSubmatch("item-42"); len(got) != 2 {
		return fmt.Errorf("正则捕获组异常: %v", got)
	}
	_ = re.ReplaceAllString("item-42", "n=$1")

	// math。
	if math.Sqrt(81) != 9 || math.Floor(1.9) != 1 || math.Max(1, 2) != 2 {
		return errors.New("数学函数结果异常")
	}

	// errors：Is / As / Join / 包装。
	sentinel := errors.New("stdprobe-sentinel")
	wrapped := fmt.Errorf("上下文: %w", sentinel)
	if !errors.Is(wrapped, sentinel) {
		return errors.New("errors.Is 未命中")
	}
	var target *url.Error
	sink = errors.As(wrapped, &target) // 结果不重要：这里只为让链接器保留这条调用路径
	_ = errors.Join(sentinel, wrapped)

	// net/url：解析 + 查询参数 + 编码。
	u, err := url.Parse("https://harness.example.com/path?a=1&b=two#frag")
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("c", strconv.Itoa(back.N))
	_ = q.Encode()
	_ = u.Hostname()
	_ = u.EscapedPath()

	// time：格式化 + 解析（不碰 LoadLocation：那会去读宿主 tzdata）。
	now := time.Now()
	stamp := now.UTC().Format(time.RFC3339Nano)
	parsed, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return err
	}
	_ = parsed.Sub(now)
	_ = now.Add(time.Millisecond)
	_ = time.Since(now)

	// encoding/base64。
	enc := base64.StdEncoding.EncodeToString(raw)
	if _, err := base64.StdEncoding.DecodeString(enc); err != nil {
		return err
	}
	_ = base64.RawURLEncoding.EncodeToString([]byte("wasi"))

	// hash/*（摘要与 HMAC）。
	sum := sha256.Sum256(raw)
	_ = sha1.Sum(raw)
	_ = sha512.Sum512(raw)
	_ = md5.Sum(raw)
	mac := hmac.New(sha256.New, []byte("key"))
	mac.Write(raw)
	_ = mac.Sum(nil)
	fnvHash := hashfnv.New32a()
	fnvHash.Write(raw)
	_ = fnvHash.Sum32()

	// io.Copy / bufio / bytes.Buffer。
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, bytes.NewReader(raw)); err != nil {
		return err
	}
	br := bufio.NewReader(strings.NewReader("alpha\nbeta\n"))
	if _, err := br.ReadString('\n'); err != nil {
		return err
	}
	bw := bufio.NewWriter(&buf)
	if _, err := bw.WriteString("tail"); err != nil {
		return err
	}
	if err := bw.Flush(); err != nil {
		return err
	}

	// context + sync（Mutex / WaitGroup）。
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var (
		mu   sync.Mutex
		wg   sync.WaitGroup
		sumN int
	)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			mu.Lock()
			sumN += v
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// 文件系统的只读面：os.Stat / os.ReadDir / os.ReadFile（零 preopen 下全 DENIED）。
	name := filepath.Join(dir, "surface.txt")
	if err := os.WriteFile(name, []byte("std-surface"), 0o600); err != nil {
		return err
	}
	if _, err := os.ReadFile(name); err != nil {
		return err
	}
	if _, err := os.Stat(name); err != nil {
		return err
	}
	if _, err := os.ReadDir(dir); err != nil {
		return err
	}

	sink = map[string]any{
		"json": back, "fields": fields, "nums": nums, "sum": sum, "buf": buf.Len(),
		"sumN": sumN, "enc": enc, "q": q.Encode(),
	}
	return nil
}

// probeGuarded 里的调用在正常执行时**不会发生**：它们会阻塞（读 stdin）或终止进程（os.Exit）。
// 放在守卫后面只是为了"让链接器保留调用"（导入进产物），不是给真跑用的。
func probeGuarded() error {
	if !guarded() {
		return nil
	}
	buf := make([]byte, 1)
	if _, err := os.Stdin.Read(buf); err != nil {
		return err
	}
	if _, err := os.Stdout.Seek(0, io.SeekCurrent); err != nil {
		return err
	}
	if _, err := os.Stderr.WriteString("guarded\n"); err != nil {
		return err
	}
	os.Exit(3)
	return nil
}
