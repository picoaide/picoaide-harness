// Package appproof 是**客户端持有性证明**（app-proof）的服务端实现。
//
// 契约与决策：docs/planning/2026-09-19-wasm-client-only-design.md §20 + §23.1（A′）。
//
// 为什么需要它（一句话）：`Origin` 是客户端协议 handler **合成**的，服务端无法把
// "应用页发起"与"攻击者自报"区分开；而任何被浏览的网页都能触发带受害者身份的
// 导航型请求。因此"应用只在客户端内"必须在服务端有**可验证的持有性证明**，
// 而不是靠自报头（R1-RED-6/RED-8/SEC-2 的攻击结论）。
//
// 本包负责四件事，别的什么都不做：
//
//	① 服务端签名密钥：**启动期按部署生成、落数据根 0600、绝不编入镜像**（见 KeyRing）；
//	② 签发与校验 proof（绑定 user_id / bearer 哈希 / install_id / serverURL /
//	   app_id / exp / jti —— 见 Proof）；
//	③ 安装公钥注册表（绑 user_id + install_id，见 InstallRegistry）；
//	④ 一次性 nonce 与非幂等请求的 jti 去重（有界 LRU，见 ReplayGuard）。
//
// ⚠️ 认账（与设计文档 §17 一致，不要在这里"顺手加强"）：本期**不做设备绑定**。
// 注册是 TOFU 语义 —— 任何持有效 bearer 的调用方都能为**尚未注册的** install_id
// 注册一把自己持有的公钥。因此本机制的真实边界是"远端第三方拿到 bearer 也不能
// 直接打平台端点"（须先注册安装密钥，而注册本身要求签名与一次性 nonce），
// 而不是"同机同用户进程之间互相隔离"。更强的形态（DPoP / OS keychain）留待客户要求。
package appproof

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 平台默认值（不是 limits 里的平台上限）。
//
// 为什么**不**放进 `limits`（R2I-21 / DAT-7 的两次重生成纪律）：`limits` 的数值
// 有一整套逐字节生成物（limits.json / limits.md / appcfg.json / 技能 references），
// 增删一个常量就要重跑生成器并改技能版本登记 —— W1 只允许做 appcfg 侧那一次
// 重生成。proof TTL 与 jti 容量属于**本机制**的实现参数，改它们不需要动任何
// 生成物，因此留在这里，由装配层按需覆盖（Options）。
const (
	// DefaultTTL 是 proof 的默认有效期（契约 §20.1：默认 15 min，可配）。
	DefaultTTL = 15 * time.Minute
	// DefaultReplayCapacity 是 jti 去重表的有界容量（契约 §23.1：10 万条）。
	DefaultReplayCapacity = 100_000
	// DefaultNonceCapacity 是一次性 nonce 表的有界容量（与 jti 同量级即可：
	// 签发频率远低于请求频率，10 万条足以覆盖 TTL 窗口内的峰值）。
	DefaultNonceCapacity = 100_000
	// maxInstallKeysPerUser 是单个用户的安装密钥上限（换机/重装的合理余量）。
	//
	// 有界的原因：注册表是一份按部署存的凭据材料，没有上限就等于"任何持 bearer 的
	// 调用方都能把它撑大"。超限时的处置 = 拒绝新 install_id（**不**淘汰旧条目 ——
	// 淘汰会让"被顶掉的那台机器"在下一次请求时静默需要重新注册）。
	maxInstallKeysPerUser = 32
	// maxKeysInRing 是密钥环里保留的历史密钥数（轮换用）。
	maxKeysInRing = 3
)

// 错误分类（service.go 把它们映射成 401 的三种对外码）。
var (
	// ErrMalformed 表示 token 结构/编码不合法，或签名无法用任何在册密钥验证。
	ErrMalformed = errors.New("appproof: proof 结构或签名非法")
	// ErrExpired 表示 proof 已过期（对外码 proof_expired）。
	ErrExpired = errors.New("appproof: proof 已过期")
	// ErrMismatch 表示绑定不符（用户/bearer/安装/服务端/应用）或 jti 重放。
	ErrMismatch = errors.New("appproof: proof 绑定不符")
	// ErrReplayed 表示一次性 nonce 或 jti 已被使用过（重放）。
	ErrReplayed = errors.New("appproof: 重放")
)

// 签发失败里"**形状类**"的三个子类（相邻缺陷，2026-09-20 本机全功能实测 + 独立对抗审计）。
//
// 现场：客户端把安装公钥按 **SPKI/DER**（44 字节）base64 发上来，而服务端要求 raw
// Ed25519（32 字节）⇒ `decodePublicKey` 失败 ⇒ 旧实现一律归到 `ErrMalformed`，于是
// 签发端点回 `proof_mismatch / signature_invalid`（"安装签名校验失败"）——
// **把公钥编码问题误报成签名问题**：对接方照着 hint 去查签名消息拼装，方向完全错
// （实测把 44 字节公钥报成签名问题，多花了一整轮定位）。
//
// 因此拆出三个可判别的原因。它们**仍 `Unwrap` 到 `ErrMalformed`**：`ErrMalformed` 是
// "proof 结构/签名非法"这个大类，既有调用方与判据按 `errors.Is(err, ErrMalformed)`
// 判大类，细分不能让它失效（否则这次修复会打红一批与本次无关的判据）。
var (
	// ErrKeyMalformed 表示**安装公钥**缺失 / 不是 base64 / 不是 raw Ed25519 32 字节。
	ErrKeyMalformed = fmt.Errorf("%w（安装公钥非法）", ErrMalformed)
	// ErrSignatureMalformed 表示**安装签名**缺失（含纯空白）/ 不是 base64 /
	// 不是 raw Ed25519 64 字节。
	ErrSignatureMalformed = fmt.Errorf("%w（安装签名非法）", ErrMalformed)
	// ErrTimestampMalformed 表示**安装签名的时间戳**不是合法的 unix 秒（缺失 / <= 0）。
	//
	// 为什么单列（AUD-3，2026-09-20 独立对抗审计）：`ts<=0` 曾经与"签名缺失"一起被
	// 折叠进同一个大条件（`if req.TS <= 0 || TrimSpace(req.Signature) == ""`），对外报成
	// `signature_invalid`（"安装签名校验失败"，hint 还让人去查 appproof-install-v1
	// 五段消息怎么拼）—— 而病根是"时间戳不是一个有效时刻"，补救是**重新取当前时间
	// 再签**（与 `timestamp_skew` 同一句话）。把非签名问题报成签名问题正是本泳道
	// 要消除的误诊。
	//
	// 为什么不归 `ErrExpired`（同样是"时间"问题）：那会把外层码从
	// `401 proof_mismatch` 变成 `401 proof_expired`（`proofIssueError` 按
	// `errors.Is(err, ErrExpired)` 分支），而"客户端按外层码重签"的策略与既有判据
	// 都建立在 `ts<=0` 属于 `ErrMalformed` 大类之上。归到 `ErrMalformed` 的子类
	// 既保住外层码，又让 `details.reason` 能如实区分。
	ErrTimestampMalformed = fmt.Errorf("%w（安装签名时间戳非法）", ErrMalformed)
)

// keyFileMode 是密钥文件与注册表文件的权限（0600，与 master.key 同口径）。
const keyFileMode = 0o600

// KeyFileName 是 proof 签名密钥在数据根里的文件名。
//
// 为什么**新开一个文件**而不是复用 `util.EnsureMasterKey`（设计 §16 W1 的二选一，
// 这里选后者并给出理由）：
//   - `master.key` 的职责是**静态数据加密**（凭证 AES-GCM）。把签名密钥塞进
//     同一个字节串等于让两套密码学用途共用一份材料 —— 任何一侧要轮换都得同时
//     换掉另一侧（凭证要重加密 / proof 全失效），而"轮换"恰恰是本机制要求支持的能力；
//   - `EnsureMasterKey` 支持 `PICOAI_MASTER_KEY` 环境变量覆盖。那个变量在多环境
//     部署里常被复用成"同一个密钥"⇒ 会把"**每部署一份**、绝不编入镜像"这条硬约束
//     静默变成"多部署共用一把"，而 proof 的 serverURL 绑定也挡不住这种同源复用；
//   - 数据根是同一个（`<dataDir>`），所以运维面没有变复杂：备份/权限/挂载点都一致。
const KeyFileName = "app-proof.key"

// InstallRegistryFileName 是安装公钥注册表在数据根里的文件名。
//
// 为什么落数据根而不是新建一张表（同样属于 §16 W1 的落点选择）：注册表是**凭据材料**
// （与签名密钥同一信任边界、同一备份口径、同一 0600），而 W1 的迁移配额只有
// 0075/0076 两条（分别归打开计数与 usage 应用维度）。放数据根的代价是"多副本部署
// 需要共享数据根才能共享注册"—— 本平台的数据根（应用库/资源/编译缓存）本来就
// 要求单实例挂载，因此不引入新的部署约束。
const InstallRegistryFileName = "app-proof-installs.json"

// ---------------------------------------------------------------------------
// 密钥环（服务端签名密钥）
// ---------------------------------------------------------------------------

// keyEntry 是密钥环里的一把密钥。
//
// 保留历史密钥是**轮换**的前提（契约 §23.1）：新密钥签发，旧密钥在 TTL 内仍可验
// —— 否则轮换瞬间所有在手 proof 全部失效，员工会看到"刚打开的应用突然要重登"。
type keyEntry struct {
	KID       string `json:"kid"`
	Seed      string `json:"seed"` // base64(std)，私钥种子（32 字节）
	CreatedAt string `json:"created_at"`
}

// keyFile 是 `<dataDir>/app-proof.key` 的磁盘结构。
type keyFile struct {
	Version int        `json:"version"`
	Keys    []keyEntry `json:"keys"`
}

// KeyRing 是进程内不可变的密钥视图（签发用最后一把，验签按 kid 查表）。
type KeyRing struct {
	entries []keyEntry
	priv    ed25519.PrivateKey
	kid     string
	pub     map[string]ed25519.PublicKey
}

// KID 返回当前签发密钥的标识。
func (k *KeyRing) KID() string { return k.kid }

// Sign 用当前密钥签名。
func (k *KeyRing) Sign(msg []byte) []byte { return ed25519.Sign(k.priv, msg) }

// Verify 用 kid 对应的公钥验签（kid 不在环里 ⇒ false，调用方按"签名不可验证"处理）。
func (k *KeyRing) Verify(kid string, msg, sig []byte) bool {
	pub, ok := k.pub[kid]
	if !ok {
		return false
	}
	return ed25519.Verify(pub, msg, sig)
}

// LoadOrCreateKeyRing 从数据根读密钥环；不存在则**生成一把新密钥**并以 0600 落盘。
//
// 三条硬约束（契约 §23.1，逐条都对得上代码）：
//   - **启动期生成**：调用方在服务启动时调用一次，失败即拒绝启动（拿不到签名密钥
//     的部署不能签发 proof，静默降级等于"应用全部打不开"且零线索）；
//   - **落数据根、0600**：密钥随部署的数据卷走，不进镜像（本文件只写运行期目录）；
//   - **支持轮换**：环里保留最近 maxKeysInRing 把；超过 staleAfter 的当前密钥会被
//     新密钥顶替（旧密钥继续留在环里直到被挤出）。
//
// 并发首启（多进程）与 EnsureMasterKey 同口径：O_EXCL 独占创建，失败方重读。
func LoadOrCreateKeyRing(dataDir string, now func() time.Time) (*KeyRing, error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("appproof: 数据根为空，无法读写 proof 签名密钥")
	}
	if now == nil {
		now = time.Now
	}
	path := filepath.Join(dataDir, KeyFileName)
	if raw, err := os.ReadFile(path); err == nil {
		ring, perr := parseKeyFile(raw)
		if perr != nil {
			// 密钥文件损坏**不**静默重新生成：那会让所有在手 proof 失效，且
			// 覆盖掉唯一一份材料（不可恢复）。让启动失败，由运维决定。
			return nil, fmt.Errorf("appproof: 读取 %s: %w", path, perr)
		}
		return ring, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("appproof: 读取 %s: %w", path, err)
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("appproof: 建数据根: %w", err)
	}
	entry, err := newKeyEntry(now())
	if err != nil {
		return nil, err
	}
	body, err := json.MarshalIndent(keyFile{Version: 1, Keys: []keyEntry{entry}}, "", "  ")
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, keyFileMode)
	if err != nil {
		if os.IsExist(err) {
			// 并发首启：另一个进程先写成功了 ⇒ 重读它那份（两份密钥并存会让
			// 两边签发的 proof 互相验不过）。
			raw, rerr := os.ReadFile(path)
			if rerr != nil {
				return nil, fmt.Errorf("appproof: 并发首启后重读 %s: %w", path, rerr)
			}
			return parseKeyFile(raw)
		}
		return nil, fmt.Errorf("appproof: 创建 %s: %w", path, err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = f.Close()
		}
	}()
	if _, err := f.Write(body); err != nil {
		return nil, fmt.Errorf("appproof: 写 %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("appproof: 关闭 %s: %w", path, err)
	}
	closed = true
	return parseKeyFile(body)
}

func newKeyEntry(now time.Time) (keyEntry, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return keyEntry{}, fmt.Errorf("appproof: 生成签名密钥: %w", err)
	}
	seed := priv.Seed()
	sum := sha256.Sum256(pub)
	return keyEntry{
		KID:       hex.EncodeToString(sum[:8]),
		Seed:      base64.StdEncoding.EncodeToString(seed),
		CreatedAt: now.UTC().Format(time.RFC3339),
	}, nil
}

func parseKeyFile(raw []byte) (*KeyRing, error) {
	var kf keyFile
	if err := json.Unmarshal(raw, &kf); err != nil {
		return nil, fmt.Errorf("不是合法 JSON: %w", err)
	}
	if len(kf.Keys) == 0 {
		return nil, errors.New("密钥环为空")
	}
	pub := make(map[string]ed25519.PublicKey, len(kf.Keys))
	entries := make([]keyEntry, 0, len(kf.Keys))
	for _, e := range kf.Keys {
		seed, err := base64.StdEncoding.DecodeString(e.Seed)
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("密钥 %s 的 seed 非法", e.KID)
		}
		if e.KID == "" {
			return nil, errors.New("密钥条目缺少 kid")
		}
		priv := ed25519.NewKeyFromSeed(seed)
		pub[e.KID] = priv.Public().(ed25519.PublicKey)
		entries = append(entries, e)
	}
	last := entries[len(entries)-1]
	seed, _ := base64.StdEncoding.DecodeString(last.Seed)
	return &KeyRing{
		entries: entries,
		priv:    ed25519.NewKeyFromSeed(seed),
		kid:     last.KID,
		pub:     pub,
	}, nil
}

// Rotate 生成一把新密钥并返回**新的**密钥环（环里保留最近 maxKeysInRing 把）。
//
// 轮换的触发由运维调用（本期不自动轮换：自动轮换需要一个稳定的"何时该换"口径，
// 而 proof TTL 只有 15 min ⇒ 频繁轮换只会让日志变吵）。
func (k *KeyRing) Rotate(dataDir string, now func() time.Time) (*KeyRing, error) {
	if now == nil {
		now = time.Now
	}
	entry, err := newKeyEntry(now())
	if err != nil {
		return nil, err
	}
	keys := append(append([]keyEntry(nil), k.entries...), entry)
	if len(keys) > maxKeysInRing {
		keys = keys[len(keys)-maxKeysInRing:]
	}
	body, err := json.MarshalIndent(keyFile{Version: 1, Keys: keys}, "", "  ")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, KeyFileName)
	if err := writeFileAtomic(path, body, keyFileMode); err != nil {
		return nil, err
	}
	return parseKeyFile(body)
}

// writeFileAtomic 先写同目录临时文件、fsync、再 rename（同目录 rename 是原子的）。
func writeFileAtomic(path string, body []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
