package serverauth

import (
	"database/sql"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// sysinfoResponse 是 /api/admin/server-info 的响应体。
// 系统信息来自 runtime/stdlib+Linux /proc(不引入 gopsutil 依赖);
// 数据库统计按驱动(SQLite/PG)查询行数与磁盘大小。
type sysinfoResponse struct {
	UptimeSec   int64      `json:"uptime_sec"`
	UptimeHuman string     `json:"uptime_human"`
	GoVersion   string     `json:"go_version"`
	NumCPU      int        `json:"num_cpu"`
	GOMAXPROCS  int        `json:"gomaxprocs"`
	Goroutines  int        `json:"goroutines"`
	Mem         memInfo    `json:"mem"`
	LoadAvg     [3]float64 `json:"load_avg"` // 1/5/15 分钟
	Disk        diskInfo   `json:"disk"`
	DB          dbStats    `json:"db"`
	Version     string     `json:"version"`
}

type memInfo struct {
	AllocatedMB    float64 `json:"allocated_mb"`
	TotalSystemMB  float64 `json:"total_system_mb"`
	SystemMemoryMB float64 `json:"system_memory_mb"` // 宿主机(读 /proc/meminfo)
}

type diskInfo struct {
	DataPath string  `json:"data_path"`
	TotalGB  float64 `json:"total_gb"`
	UsedGB   float64 `json:"used_gb"`
	FreeGB   float64 `json:"free_gb"`
	UsedPct  float64 `json:"used_pct"`
}

// dbStats 是数据库统计(行数按表/磁盘大小按后端)。
type dbStats struct {
	Driver       string           `json:"driver"` // sqlite | pg
	BuildVersion string           `json:"-"`      // 内部
	Tables       map[string]int64 `json:"tables"` // 表名 -> 行数
	TotalRows    int64            `json:"total_rows"`
	DiskBytes    int64            `json:"disk_bytes"`
	DiskHuman    string           `json:"disk_human"`
	SchemaMig    int64            `json:"schema_migrations"` // 迁移版本
}

// statTables 是需要统计行数的业务表(与 serverstore 迁移一致)。
var statTables = []string{
	"users", "groups", "user_groups", "settings", "api_tokens",
	"gateway_providers", "models", "usage", "skills", "skill_grants",
	"audit_logs", "admin_sessions",
}

// handleServerInfo 返回服务器系统信息 + 数据库统计(AdminAuth 保护)。
func (a *AdminAPI) handleServerInfo(c *gin.Context) {
	resp := sysinfoResponse{
		UptimeSec:   int64(time.Since(startTime).Seconds()),
		UptimeHuman: humanDuration(time.Since(startTime)),
		GoVersion:   runtime.Version(),
		NumCPU:      runtime.NumCPU(),
		GOMAXPROCS:  runtime.GOMAXPROCS(0),
		Goroutines:  runtime.NumGoroutine(),
		LoadAvg:     [3]float64{0, 0, 0},
		Version:     buildVersion,
	}

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	resp.Mem = memInfo{
		AllocatedMB:    round1(float64(ms.Alloc) / 1024 / 1024),
		TotalSystemMB:  round1(float64(ms.Sys) / 1024 / 1024),
		SystemMemoryMB: hostMemoryMB(),
	}

	resp.LoadAvg = hostLoadAvg()

	resp.Disk = hostDisk("/data")

	// 数据库统计
	dbStats, err := collectDBStats(a.DB)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败: "+err.Error())
		return
	}
	resp.DB = dbStats

	c.JSON(http.StatusOK, resp)
}

// ---- 启动时间(包级,进程启动时设置) ----
var startTime = time.Now()

// buildVersion 可在构建时注入(-X main.buildVersion? 用包内变量,保持简单)。
var buildVersion = "dev"

// collectDBStats 按驱动收集行数与磁盘大小。
func collectDBStats(db *sql.DB) (dbStats, error) {
	s := dbStats{Tables: map[string]int64{}}
	// PG-only(2026-08 SQLite 已下线):驱动固定 pg,磁盘大小查 pg_database_size
	s.Driver = "pg"

	for _, t := range statTables {
		var n int64
		if err := db.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&n); err != nil {
			continue // 表不存在(旧库可能缺)跳过
		}
		s.Tables[t] = n
		s.TotalRows += n
	}
	s.SchemaMig = schemaVersion(db)

	// PG: 数据库大小
	var bytes int64
	_ = db.QueryRow("SELECT pg_database_size(current_database())").Scan(&bytes)
	s.DiskBytes = bytes
	s.DiskHuman = humanBytes(bytes)
	return s, nil
}

// schemaVersion 读 schema_migrations 最新版本。
func schemaVersion(db *sql.DB) int64 {
	var v int64
	_ = db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&v)
	return v
}

// ---- Linux /proc 读取(标准库,无额外依赖) ----

// hostMemoryMB 读 /proc/meminfo 的 MemTotal。
func hostMemoryMB() float64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseFloat(fields[1], 64)
				return round1(kb / 1024)
			}
		}
	}
	return 0
}

// hostLoadAvg 读 /proc/loadavg。
func hostLoadAvg() [3]float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return [3]float64{0, 0, 0}
	}
	fields := strings.Fields(string(b))
	var out [3]float64
	for i := 0; i < 3 && i < len(fields); i++ {
		out[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return out
}

// hostDisk 读 path 所在文件系统的磁盘统计(syscall.Statfs)。
func hostDisk(path string) diskInfo {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return diskInfo{DataPath: path}
	}
	total := st.Blocks * uint64(st.Bsize)
	free := st.Bavail * uint64(st.Bsize)
	used := total - (st.Bfree * uint64(st.Bsize))
	pct := 0.0
	if total > 0 {
		pct = round1(float64(used) / float64(total) * 100)
	}
	return diskInfo{
		DataPath: path,
		TotalGB:  round1(float64(total) / 1024 / 1024 / 1024),
		UsedGB:   round1(float64(used) / 1024 / 1024 / 1024),
		FreeGB:   round1(float64(free) / 1024 / 1024 / 1024),
		UsedPct:  pct,
	}
}

// ---- 工具 ----

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

func humanBytes(n int64) string {
	if n >= 1024*1024*1024 {
		return strconv.FormatFloat(float64(n)/1024/1024/1024, 'f', 1, 64) + "GB"
	}
	if n >= 1024*1024 {
		return strconv.FormatFloat(float64(n)/1024/1024, 'f', 1, 64) + "MB"
	}
	return strconv.FormatFloat(float64(n)/1024, 'f', 1, 64) + "KB"
}

func humanDuration(d time.Duration) string {
	sec := int64(d.Seconds())
	day := sec / 86400
	h := (sec % 86400) / 3600
	m := (sec % 3600) / 60
	if day > 0 {
		return strconv.FormatInt(day, 10) + "天" + strconv.FormatInt(h, 10) + "时" + strconv.FormatInt(m, 10) + "分"
	}
	if h > 0 {
		return strconv.FormatInt(h, 10) + "时" + strconv.FormatInt(m, 10) + "分"
	}
	return strconv.FormatInt(m, 10) + "分" + strconv.FormatInt(sec%60, 10) + "秒"
}
