package appproof

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// installKey 是一个已注册的安装公钥。
type installKey struct {
	InstallID string `json:"install_id"`
	PublicKey string `json:"public_key"` // base64(std) of the 32-byte Ed25519 key
	CreatedAt string `json:"created_at"`
}

// registryFile 是注册表的磁盘结构（按用户分组）。
type registryFile struct {
	Version int                     `json:"version"`
	Users   map[string][]installKey `json:"users"`
}

// InstallRegistry 是**安装公钥注册表**（绑 user_id + install_id，契约 §23.1）。
//
// 语义（TOFU：首次注册即绑定，见包注释的认账条目）：
//
//	(user_id, install_id) 未注册 ⇒ 登记提交的公钥；
//	已注册且公钥相同         ⇒ 通过（同一台机器的正常续签）；
//	已注册且公钥不同         ⇒ 拒绝（换机/重装必须换 install_id，不允许悄悄换钥匙）。
//
// 为什么"公钥不同就拒"而不是"重新绑定"：静默重绑等于把注册表降级成"最后一次
// 写入者获胜"——任何持 bearer 的调用方都能顶掉别人的安装，那这个绑定就不存在了。
//
// 有界：单用户最多 maxInstallKeysPerUser 条，超限**拒绝新 install_id**（不淘汰旧条目，
// 见常量注释）。落盘是原子写（临时文件 + rename），权限 0600。
type InstallRegistry struct {
	path string
	now  func() time.Time

	mu   sync.Mutex
	data registryFile
}

// LoadInstallRegistry 读取（或初始化）注册表。
func LoadInstallRegistry(dataDir string, now func() time.Time) (*InstallRegistry, error) {
	if now == nil {
		now = time.Now
	}
	r := &InstallRegistry{
		path: filepath.Join(dataDir, InstallRegistryFileName),
		now:  now,
		data: registryFile{Version: 1, Users: map[string][]installKey{}},
	}
	raw, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return r, nil // 首次启动：空表，落盘推迟到第一次注册
		}
		return nil, fmt.Errorf("appproof: 读取安装注册表 %s: %w", r.path, err)
	}
	var rf registryFile
	if err := json.Unmarshal(raw, &rf); err != nil {
		// 与密钥环同理：静默重建等于丢掉所有绑定（每个人都变成"未注册"，
		// 于是任何持 bearer 的调用方都能重新注册）⇒ 让启动失败。
		return nil, fmt.Errorf("appproof: 解析安装注册表 %s: %w", r.path, err)
	}
	if rf.Users == nil {
		rf.Users = map[string][]installKey{}
	}
	r.data = rf
	return r, nil
}

// Lookup 返回该 (user, install) 已注册的公钥（未注册返回 ok=false）。
func (r *InstallRegistry) Lookup(userID int64, installID string) (string, bool) {
	if r == nil {
		return "", false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range r.data.Users[keyOf(userID)] {
		if k.InstallID == installID {
			return k.PublicKey, true
		}
	}
	return "", false
}

// Register 登记一把安装公钥；已存在且同值时幂等通过。
//
// 返回 ErrMismatch 表示"已注册但公钥不同"；用户条目已满时返回 ErrMismatch
// （对外都是"这份证明与注册信息不符"，不给攻击者区分"满了"与"换了钥匙"）。
func (r *InstallRegistry) Register(userID int64, installID, pubKeyB64 string) error {
	if r == nil {
		return fmt.Errorf("appproof: 安装注册表未装配")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := keyOf(userID)
	list := r.data.Users[key]
	for _, k := range list {
		if k.InstallID == installID {
			if k.PublicKey == pubKeyB64 {
				return nil // 幂等
			}
			return ErrMismatch
		}
	}
	if len(list) >= maxInstallKeysPerUser {
		return ErrMismatch
	}
	list = append(list, installKey{
		InstallID: installID,
		PublicKey: pubKeyB64,
		CreatedAt: r.now().UTC().Format(time.RFC3339),
	})
	r.data.Users[key] = list
	return r.persistLocked()
}

// Count 返回某用户已注册的安装数（诊断/用例用）。
func (r *InstallRegistry) Count(userID int64) int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.data.Users[keyOf(userID)])
}

func (r *InstallRegistry) persistLocked() error {
	body, err := json.MarshalIndent(r.data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	return writeFileAtomic(r.path, body, keyFileMode)
}

func keyOf(userID int64) string {
	return fmt.Sprintf("%d", userID)
}

// ---------------------------------------------------------------------------
// 一次性 nonce / jti 去重（有界 LRU）
// ---------------------------------------------------------------------------

// ReplayGuard 是**有界**的一次性键表（nonce 与 jti 共用同一实现）。
//
// 契约（§23.1）：容量 10 万条、条目在 TTL 内一律视为"已用过"，超容量丢最旧的。
//
// 为什么是"丢最旧"而不是"满了拒绝"：这是**防重放**而不是配额。丢最旧意味着
// 一个被驱逐的旧键理论上可再次使用（LRU 的固有代价），而它的窗口只有 TTL 之内；
// "满了拒绝"则会让正常流量在峰值时整批 401 —— 用一个可用性事故换一个极窄的
// 安全增益，不划算。TTL = proof TTL，超过 TTL 的 proof 本来就过不了 Exp 判定。
type ReplayGuard struct {
	ttl      time.Duration
	capacity int
	now      func() time.Time

	mu    sync.Mutex
	seen  map[string]int64 // key -> 过期 unix 秒
	order []string         // FIFO（插入序）
	head  int              // order 的有效起点
}

// NewReplayGuard 构造一个有界一次性键表。
func NewReplayGuard(capacity int, ttl time.Duration, now func() time.Time) *ReplayGuard {
	if capacity <= 0 {
		capacity = DefaultReplayCapacity
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if now == nil {
		now = time.Now
	}
	return &ReplayGuard{ttl: ttl, capacity: capacity, now: now, seen: map[string]int64{}}
}

// Consume 尝试消费一个一次性键：返回 true = 首次（放行），false = 已用过（重放）。
func (g *ReplayGuard) Consume(key string) bool {
	if g == nil || key == "" {
		// 未装配 / 空键：按"未被用过"处理。空键只可能来自本包内部（jti 恒非空），
		// 因此这不是一条安全分支。
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now().UTC().Unix()
	if exp, ok := g.seen[key]; ok && exp > now {
		return false
	}
	g.seen[key] = now + int64(g.ttl/time.Second)
	g.order = append(g.order, key)
	g.evictLocked(now)
	return true
}

// evictLocked 维护容量与内存上界：先按 FIFO 挤到容量内，再在过期条目占比过高时压缩。
func (g *ReplayGuard) evictLocked(now int64) {
	for len(g.seen) > g.capacity && g.head < len(g.order) {
		delete(g.seen, g.order[g.head])
		g.order[g.head] = ""
		g.head++
	}
	// 压缩：order 的已消费前缀超过容量时整体前移（否则长跑进程的 order 会无限增长）。
	if g.head > g.capacity {
		rest := append([]string(nil), g.order[g.head:]...)
		g.order = rest
		g.head = 0
	}
	// 过期条目也顺手清一遍（避免"低频部署"下 seen 长期只增不减）。
	if len(g.seen) > g.capacity/2 {
		for k, exp := range g.seen {
			if exp <= now {
				delete(g.seen, k)
			}
		}
	}
}

// Len 返回当前在册键数（用例与诊断用）。
func (g *ReplayGuard) Len() int {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.seen)
}
