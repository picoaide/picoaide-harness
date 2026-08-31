package serverstore

import (
	"database/sql"
	"time"
)

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
