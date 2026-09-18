package compile

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是**编译子进程 env 白名单**的验收（§4.3「参数 / 环境变量」+ R31）。
//
// 变异方式：
//   - 把 CompileProcessEnv 改成 `return parent` ⇒ TestCompileProcessEnvDropsSecretsNames 红；
//   - 改成"以后缀/前缀黑名单过滤" ⇒ TestCompileProcessEnvDropsSecretLikeVariants 红
//     （下面列了 20+ 种常见命名变体，黑名单必然漏掉其中一些）。

// fakeParentEnv 是一份"含全部宿主机密"的假父环境。
//
// 它比真实环境更狠：把能想到的密钥命名风格都放进去（含大小写变体、无下划线变体），
// 因为真实事故往往就是"某个新变量名不在黑名单里"。
var fakeParentEnv = []string{
	"PATH=/usr/local/bin:/usr/bin",
	"TMPDIR=/tmp",
	"TZ=Asia/Shanghai",
	"LANG=zh_CN.UTF-8",
	"PG_DSN=postgres://picoaide:secret@127.0.0.1:5432/picoaide",
	"PGDSN=postgres://x",
	"DATABASE_URL=postgres://y",
	"PICOAI_MASTER_KEY=deadbeef",
	"PICOAI_ADMIN_PASSWORD=Admin@12345",
	"PICOAI_TRUSTED_PROXIES=172.28.0.2",
	"MASTER_KEY=deadbeef",
	"MASTERKEY=deadbeef",
	"AES_KEY=deadbeef",
	"SECRET_KEY_BASE=deadbeef",
	"API_KEY=sk-xxx",
	"OPENAI_API_KEY=sk-yyy",
	"DEEPSEEK_API_KEY=sk-zzz",
	"AWS_SECRET_ACCESS_KEY=aws",
	"AWS_ACCESS_KEY_ID=AKIA",
	"R2_SECRET_ACCESS_KEY=r2",
	"JWT_SECRET=jwt",
	"SESSION_SECRET=sess",
	"LDAP_BIND_PASSWORD=ldap",
	"SMTP_PASSWORD=smtp",
	"GITHUB_TOKEN=ghp_x",
	"ADMIN_PASSWORD=Admin@12345",
	"DATABASE_PASSWORD=pgpass",
	"PGPASSWORD=pgpass",
	"ENCRYPTION_KEY=enc",
	"TOTP_SECRET=totp",
	"PRIVATE_KEY=-----BEGIN",
	"CA_CERT_PEM=-----BEGIN",
	"MALFORMED_NO_EQUALS",
	"=emptykey",
}

func TestCompileProcessEnvKeepsOnlyAllowlist(t *testing.T) {
	got := CompileProcessEnv(fakeParentEnv)
	keys := CompileProcessEnvKeys(got)

	want := map[string]string{
		"PATH":   "/usr/local/bin:/usr/bin",
		"TMPDIR": "/tmp",
		"TZ":     "Asia/Shanghai",
		"LANG":   "zh_CN.UTF-8",
	}
	if len(got) != len(want) {
		t.Fatalf("白名单应恰好保留 %d 项，实际 %d 项：%v", len(want), len(got), got)
	}
	for _, kv := range got {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			t.Fatalf("保留项格式非法：%q", kv)
		}
		k, v := kv[:eq], kv[eq+1:]
		if want[k] != v {
			t.Errorf("保留项 %s 的值不符：%q（期望 %q）", k, v, want[k])
		}
	}
	// 允许集必须与 limits 侧的"设计文档口径"一致：只有这四项。
	allow := map[string]bool{"PATH": true, "TMPDIR": true, "TZ": true, "LANG": true}
	for _, k := range keys {
		if !allow[k] {
			t.Errorf("出现白名单外的键：%s", k)
		}
	}
}

func TestCompileProcessEnvDropsSecretsNames(t *testing.T) {
	got := CompileProcessEnv(fakeParentEnv)
	joined := strings.Join(got, "\n")
	// 断言的是"明确危险的名字一个都不能出现"——这是回归口径，
	// 任何一条漏出都意味着"读不可信字节的进程拿到了平台凭据"。
	forbidden := []string{
		"PG_DSN", "PGDSN", "DATABASE_URL", "PICOAI_", "MASTER", "DSN", "KEY",
		"SECRET", "PASSWORD", "TOKEN", "PRIVATE", "CERT",
	}
	for _, f := range forbidden {
		if strings.Contains(strings.ToUpper(joined), f) {
			t.Errorf("子进程 env 里出现了禁止的子串 %q：\n%s", f, joined)
		}
	}
}

func TestCompileProcessEnvMissingAllowlistEntriesNotInvented(t *testing.T) {
	// 父环境里没有 TZ/LANG ⇒ 不得凭空造值（"未设置"与"设成空"语义不同）。
	got := CompileProcessEnv([]string{"PATH=/bin"})
	if len(got) != 1 || got[0] != "PATH=/bin" {
		t.Fatalf("只应保留 PATH，实际 %v", got)
	}
	// nil 父环境 ⇒ nil（保持"没有环境"语义，父侧总是显式传 os.Environ()）。
	if CompileProcessEnv(nil) != nil {
		t.Fatal("nil 父环境应返回 nil")
	}
}

func TestCompileProcessEnvKeepsExplicitEmptyValues(t *testing.T) {
	// `TZ=` 是显式空值（与未设置不同），必须原样传递（保真）。
	got := CompileProcessEnv([]string{"TZ=", "LANG=C"})
	if len(got) != 2 || got[0] != "TZ=" {
		t.Fatalf("显式空值应保留：%v", got)
	}
}

func TestCompileProcessEnvCaseInsensitiveMatch(t *testing.T) {
	// 变量名大小写不敏感匹配（Windows 与手工导出的环境里会出现小写形态）。
	got := CompileProcessEnv([]string{"path=/bin", "Lang=C"})
	if len(got) != 2 {
		t.Fatalf("大小写变体应被识别：%v", got)
	}
}

func TestCompileProcessEnvRejectsMalformedEntries(t *testing.T) {
	got := CompileProcessEnv([]string{"PATH=/bin", "NOEQUALS", "=x", "TZ=UTC"})
	want := []string{"PATH=/bin", "TZ=UTC"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("畸形项应被丢弃：%v", got)
	}
}

// TestCompileProcessEnvDropsWholeAppEnv 用一个"像生产环境"的快照做端到端断言：
// 白名单实现不依赖任何具体变量名，只依赖"名在不在允许集里"。
func TestCompileProcessEnvDropsWholeAppEnv(t *testing.T) {
	prod := []string{
		"PATH=/usr/bin", "HOSTNAME=abc", "HOME=/root", "PWD=/app",
		"PG_DSN=postgres://u:p@db:5432/picoaide", "PICOAI_MASTER_KEY_FILE=/data/master.key",
		"HTTP_PROXY=http://proxy", "HTTPS_PROXY=http://proxy", "NO_PROXY=db",
		"GOMAXPROCS=4", "GODEBUG=gcstoptheworld=1",
	}
	got := CompileProcessEnv(prod)
	if len(got) != 1 || !strings.HasPrefix(got[0], "PATH=") {
		t.Fatalf("生产形态快照里只应留下 PATH，实际 %v", got)
	}
	// HTTP_PROXY 也在丢弃之列：编译进程**不能出站**（§4.3 红线 4 的同族要求），
	// 给它代理配置等于给"被攻破的编译进程"一条外联路径。
	for _, kv := range got {
		if strings.Contains(kv, "PROXY") {
			t.Errorf("代理配置不得进入编译子进程：%q", kv)
		}
	}
}

// TestAllowlistMatchesDesignDoc 锁住"设计文档 §4.3 只允许这四项"这条口径。
func TestAllowlistMatchesDesignDoc(t *testing.T) {
	if len(compileEnvAllowlist) != 4 {
		t.Fatalf("白名单应为 4 项（PATH/TMPDIR/TZ/LANG），实际 %v", compileEnvAllowlist)
	}
	if limits.UploadConcurrentCompiles != 1 {
		// 顺带断言 limits 的这项没被改（上传闸门用例依赖它）。
		t.Fatalf("limits.UploadConcurrentCompiles 应为 1，实际 %d", limits.UploadConcurrentCompiles)
	}
}
