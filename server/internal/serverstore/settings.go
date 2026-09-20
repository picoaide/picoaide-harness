package serverstore

import (
	"database/sql"
	"strconv"
	"time"
)

// AuthMinPasswordLengthSetting 密码最小长度 settings 键(管理面可配,默认 10)。
const AuthMinPasswordLengthSetting = "auth.min_password_length"

// DefaultMinPasswordLength 密码最小长度默认值(与历史常量 minPasswordLength=10 一致)。
const DefaultMinPasswordLength = 10

// MinPasswordLengthBounds 密码最小长度允许范围。
const (
	MinPasswordLengthLower = 8
	MinPasswordLengthUpper = 64
)

// AuthMinPasswordLength 读取密码最小长度:settings 缺失/非法(非 8~64 整数)
// 回落默认 10。所有密码校验点(建用户/重置/自助改密/bootstrap)统一读此值。
func AuthMinPasswordLength(db *sql.DB) int {
	if db == nil {
		return DefaultMinPasswordLength
	}
	v, ok, err := GetSetting(db, AuthMinPasswordLengthSetting)
	if err != nil || !ok || v == "" {
		return DefaultMinPasswordLength
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < MinPasswordLengthLower || n > MinPasswordLengthUpper {
		return DefaultMinPasswordLength
	}
	return n
}

// AuditRetentionSetting 审计日志保留天数 settings 键(默认 180)。
const AuditRetentionSetting = "audit.retention_days"

// DefaultAuditRetentionDays 审计日志保留默认天数。
const DefaultAuditRetentionDays = 180

// AuditRetentionDays 读取审计保留天数:缺失/非法回落默认 180。
func AuditRetentionDays(db *sql.DB) int {
	if db == nil {
		return DefaultAuditRetentionDays
	}
	v, ok, err := GetSetting(db, AuditRetentionSetting)
	if err != nil || !ok || v == "" {
		return DefaultAuditRetentionDays
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return DefaultAuditRetentionDays
	}
	return n
}

// settingsTTL settings 缓存时长:kv 表低频变更(webadmin 配置),而热路径
// 每请求读多键(quota/rate_limit/peak_windows)。30s TTL,SetSetting 主动失效。
const settingsTTL = 30 * time.Second

var settingsCache = newTTLCache(settingsTTL)

// InvalidateSettings 使 settings 缓存失效(SetSetting 后调用)。
func InvalidateSettings() { settingsCache.invalidateAll() }

// SetSetting upserts a settings key/value.
func SetSetting(db *sql.DB, key, value string) error {
	_, err := db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	if err == nil {
		settingsCache.invalidateAll()
	}
	return err
}

// SetSettingTx 在调用方事务内 upsert(不主动失效缓存;提交后调用方须
// 调用 InvalidateSettings)。
func SetSettingTx(tx *sql.Tx, key, value string) error {
	_, err := tx.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// DeleteSetting 删除一个 settings 键并返回"是否真的删掉了一行"（键不存在不算错）。
//
// 为什么必须**失效缓存**（与 SetSetting 对称，缺了它回落会静默失效）：GetSetting 会把
// "键不存在"（ok=false）也缓存 30s，而它同样缓存了删除前的旧值 —— 不失效就会出现
// "库里已经删了、读侧 30s 内仍看得见"，而"显式清空设置回落到部署档位"这类运维动作
// 恰恰是**先删后读**（下一次启动重新解析优先级）。设置缓存是全局单例（settingsCache），
// 所以这里与 SetSetting 用同一把失效口径。
func DeleteSetting(db *sql.DB, key string) (bool, error) {
	res, err := db.Exec(`DELETE FROM settings WHERE key = ?`, key)
	if err != nil {
		return false, err
	}
	settingsCache.invalidateAll()
	n, err := res.RowsAffected()
	if err != nil {
		// 删除本身已经成功；行数拿不到不影响语义（调用方只关心"删掉了吗"）。
		return true, nil
	}
	return n > 0, nil
}

// GetSetting returns the value and whether it exists.
func GetSetting(db *sql.DB, key string) (string, bool, error) {
	if v := settingsCache.get(db, "s:"+key); v != nil {
		e := v.(cacheEntryVal)
		return e.value, e.ok, nil
	}
	var v string
	err := db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if err == sql.ErrNoRows {
		settingsCache.set(db, "s:"+key, cacheEntryVal{ok: false})
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	settingsCache.set(db, "s:"+key, cacheEntryVal{value: v, ok: true})
	return v, true, nil
}

// cacheEntryVal settings 缓存值(ok=false 表示 key 不存在,防反复 miss 查询)。
type cacheEntryVal struct {
	value string
	ok    bool
}

// GetAllSettings returns a flattened key/value map.
func GetAllSettings(db *sql.DB) (map[string]string, error) {
	rows, err := db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
