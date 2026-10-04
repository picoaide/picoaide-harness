package channel

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// 渠道配置的**三态**：不存在 = 正常；存在但不可用 = 出声（2026-10 审计本泳道）
//
// 被审形态：旧 `loadPresent` 把"文件存在但非普通文件 / 读失败 / 超限 / 解析失败"
// 与"文件不存在"混成同一个 `present=false`，于是
//   - 品牌渠道静默变回中性占位 "Harness"（`Load()` 回落 fallback）；
//   - `AppOriginScheme()` 静默回落默认 scheme（启动期不报错）；
//   - 三个素材端点静默 404（`assetRegular` 同一语义）；
//   - **日志一个字都没有** —— 现场表现只有"品牌没了/图没了"，没有线索指向 channel.json。
//
// 修后的判据（本文件）：
//  1. 三态可分（`loadPresent().state`），且"存在但不可用"带上**路径 + 病根**；
//  2. `Load()` 的返回值语义**不变**（仍是中性占位 —— 调用点遍布门户/登录页）；
//  3. 出声恰好一次（同一个病根不刷屏；病根变了再出声）；
//  4. 素材同理：**没配置**静默，**盘上形态不对**出声；
//  5. `AppOriginScheme()`（cmd/server 的启动期调用点）对"存在但不可用"fail-loud。
//
// 反向（"不存在"）在每张表里都有对照行：没有它，"什么都报错"也能通过。
// ---------------------------------------------------------------------------

// captureChannelLog 抓取本包打到标准 logger 的输出，并把"已出声"的去重位清零。
//
// 为什么要清零：去重位是包级 atomic（跨用例共享），不清零时后一个用例会被前一个
// 用例的病根文案"顶掉"而看不见自己那一行 —— 那会让判据变成"顺序的函数"。
func captureChannelLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	lastManifestProblem.Store(nil)
	var buf bytes.Buffer
	flags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(flags)
		lastManifestProblem.Store(nil)
	})
	return &buf
}

func TestManifestStatesDistinguishAbsentFromBroken(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T)
		want  manifestState
		// wantNeedle 是"病根文案里必须出现的片段"（broken 行）。
		wantNeedle string
	}{
		{
			name:  "不存在（正常：本地开发构建没带渠道配置）",
			setup: func(t *testing.T) { withDir(t, nil) },
			want:  manifestAbsent,
		},
		{
			name: "符号链接（渠道包里的链接会被 cp -a / docker COPY 原样带进镜像）",
			setup: func(t *testing.T) {
				withDir(t, map[string]string{"real.json": officialJSON})
				if err := os.Symlink(filepath.Join(Dir, "real.json"), filepath.Join(Dir, "channel.json")); err != nil {
					t.Skipf("本环境不支持符号链接（%v）：该形态构造不出来", err)
				}
			},
			want:       manifestBroken,
			wantNeedle: "符号链接",
		},
		{
			name: "目录（同名目录冒充配置文件）",
			setup: func(t *testing.T) {
				withDir(t, nil)
				if err := os.Mkdir(filepath.Join(Dir, "channel.json"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			want:       manifestBroken,
			wantNeedle: "目录",
		},
		{
			name: "超限（> maxConfigBytes）",
			setup: func(t *testing.T) {
				withDir(t, map[string]string{"channel.json": strings.Repeat("x", maxConfigBytes+1)})
			},
			want:       manifestBroken,
			wantNeedle: "超过体积上限",
		},
		{
			name:  "JSON 非法",
			setup: func(t *testing.T) { withDir(t, map[string]string{"channel.json": "{ not json"}) },
			want:  manifestBroken, wantNeedle: "不是合法 JSON",
		},
		{
			name:  "缺 channel_id",
			setup: func(t *testing.T) { withDir(t, map[string]string{"channel.json": `{"schema":1}`}) },
			want:  manifestBroken, wantNeedle: "缺少 channel_id",
		},
		{
			// ENOTDIR（Dir 本身是个文件）：Lstat 的 err 不是 ENOENT ⇒ 必须算"存在但
			// 不可用"，不能像旧实现那样按"不存在"静默回落（旧实现：err != nil ⇒ absent）。
			name: "路径不可用（Dir 是普通文件 ⇒ ENOTDIR）",
			setup: func(t *testing.T) {
				file := filepath.Join(t.TempDir(), "not-a-dir")
				if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
					t.Fatal(err)
				}
				Dir = file
				t.Cleanup(func() { Dir = defaultDir })
			},
			want:       manifestBroken,
			wantNeedle: "无法读取",
		},
		{
			name:  "对照：普通文件 + 合法内容（正常路径仍然 ok）",
			setup: func(t *testing.T) { withDir(t, map[string]string{"channel.json": officialJSON}) },
			want:  manifestOK,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			buf := captureChannelLog(t)
			tc.setup(t)
			got := loadPresent()
			if got.state != tc.want {
				t.Fatalf("loadPresent().state = %v, want %v（err=%v）", got.state, tc.want, got.err)
			}
			switch tc.want {
			case manifestBroken:
				if got.err == nil {
					t.Fatal("发生「存在但不可用」却没有带病根 error")
				}
				// 病根必须点名**绝对路径**与**具体形态**（否则运维还得自己猜是哪个文件）。
				if !strings.Contains(got.err.Error(), filepath.Join(Dir, "channel.json")) {
					t.Fatalf("病根没有点名路径: %v", got.err)
				}
				if !strings.Contains(got.err.Error(), tc.wantNeedle) {
					t.Fatalf("病根没有点名形态 %q: %v", tc.wantNeedle, got.err)
				}
				// 出声：Load() 调用点遍布请求路径，返回值语义不变（中性占位），
				// 但必须留下一条可 grep 的 ERROR。
				if cfg := Load(); cfg.Identity.DisplayName == "" {
					t.Fatal("损坏配置仍必须回落中性占位（调用点没有 error 出口）")
				}
				line := buf.String()
				if !strings.Contains(line, "ERROR channel: 渠道配置文件存在但不可用") {
					t.Fatalf("存在但不可用必须出声，实得日志: %q", line)
				}
				if !strings.Contains(line, tc.wantNeedle) {
					t.Fatalf("日志没有点名形态 %q: %q", tc.wantNeedle, line)
				}
			case manifestAbsent:
				if cfg := Load(); cfg.ChannelID != "official" || cfg.Identity.DisplayName == "" {
					t.Fatalf("配置不存在时必须回落中性值, got %+v", cfg)
				}
				if line := buf.String(); line != "" {
					t.Fatalf("配置不存在是**正常**情形，不得出声，实得日志: %q", line)
				}
			case manifestOK:
				if line := buf.String(); line != "" {
					t.Fatalf("正常配置不得出声，实得日志: %q", line)
				}
			}
		})
	}
}

// TestBrokenManifestReportsOncePerReason：同一个病根只出声一次（Load 是每请求调用
// 的函数，不去重会把日志刷爆并把病根淹没）；病根变了要再出声（否则"换了个坏法"就瞎了）。
func TestBrokenManifestReportsOncePerReason(t *testing.T) {
	buf := captureChannelLog(t)
	withDir(t, map[string]string{"channel.json": "{ not json"})

	const calls = 5
	for i := 0; i < calls; i++ {
		_ = Load()
	}
	if n := strings.Count(buf.String(), "ERROR channel:"); n != 1 {
		t.Fatalf("%d 次 Load() 的出错行数 = %d, want 1（同一病根只出声一次）:\n%s", calls, n, buf.String())
	}

	// 病根变了（坏法从"JSON 非法"换成"符号链接"）⇒ 必须再出一行。
	if err := os.Remove(filepath.Join(Dir, "channel.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(Dir, "target.json"), []byte(officialJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(Dir, "target.json"), filepath.Join(Dir, "channel.json")); err != nil {
		t.Skipf("本环境不支持符号链接（%v）", err)
	}
	_ = Load()
	if n := strings.Count(buf.String(), "ERROR channel:"); n != 2 {
		t.Fatalf("病根换了之后出错行数 = %d, want 2:\n%s", n, buf.String())
	}
}

// TestAppOriginSchemeFailsLoudWhenManifestBroken：启动期调用点（cmd/server 的
// resolveStartupChannel → validateAppOriginScheme）必须对"存在但不可用"fail-loud。
//
// 为什么这条最关键：这是**唯一**由启动装配调用的 channel 出口。旧实现让它对坏配置
// 静默回落默认 scheme ⇒ 服务端带着"猜出来的"scheme 起来，而客户端注册的是渠道配的
// 那一个 ⇒ 全部非幂等应用请求 403，故障现象与配置毫无关系。
func TestAppOriginSchemeFailsLoudWhenManifestBroken(t *testing.T) {
	buf := captureChannelLog(t)
	withDir(t, map[string]string{"channel.json": `{"schema":1,"channel_id":"acme",
      "desktop":{"deep_link_scheme":"acmeai","app_origin_scheme":"acmeai-app"}}`})
	if err := os.Remove(filepath.Join(Dir, "channel.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(Dir, "channel.json"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := AppOriginScheme()
	if err == nil {
		t.Fatalf("配置存在但不可用时 AppOriginScheme() 必须报错，实得 %q（旧实现：静默回落默认 scheme）", got)
	}
	if !strings.Contains(err.Error(), "存在但不可用") || !strings.Contains(err.Error(), "目录") {
		t.Fatalf("启动期错误必须点名病根: %v", err)
	}
	if !strings.Contains(buf.String(), "ERROR channel:") {
		t.Fatalf("fail-loud 之前也要留下可 grep 的 ERROR 行: %q", buf.String())
	}
	// 对照：目录整个不存在仍必须中性回落（本地开发构建的既有约定，不得被这次修复改掉）。
	withDir(t, nil)
	got, err = AppOriginScheme()
	if err != nil || got != DefaultAppOriginScheme {
		t.Fatalf("渠道目录缺失时不得 fail-loud: got=(%q, %v)", got, err)
	}
}

// TestAssetPresentButNotRegularIsLoud 钉素材侧的同一区分：
//   - 配置里写了名字但盘上没有那个文件（"未配置"）⇒ 静默（产品语义，端点 404）；
//   - 盘上有那个名字但**不是普通文件** ⇒ 端点照旧 404，但必须出声点名路径与形态。
func TestAssetPresentButNotRegularIsLoud(t *testing.T) {
	buf := captureChannelLog(t)
	withDir(t, map[string]string{"channel.json": officialJSON})

	// ① 未配置 / 盘上没有：静默，且"没有可下发素材"这一事实不变。
	if LogoPath(false) != "" {
		t.Fatal("没有 logo 文件时 LogoPath 必须返回空")
	}
	if line := buf.String(); line != "" {
		t.Fatalf("素材缺失是正常情形，不得出声: %q", line)
	}

	// ② 盘上有，但是符号链接 ⇒ 404 语义不变，但出声。
	target := filepath.Join(t.TempDir(), "outside.svg")
	if err := os.WriteFile(target, []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(Dir, "logo.svg")); err != nil {
		t.Skipf("本环境不支持符号链接（%v）", err)
	}
	if got := LogoPath(false); got != "" {
		t.Fatalf("素材是符号链接时 LogoPath 必须返回空（端点 404），实得 %q", got)
	}
	line := buf.String()
	if !strings.Contains(line, "ERROR channel: 渠道素材存在但不可用") {
		t.Fatalf("素材形态不对必须出声: %q", line)
	}
	if !strings.Contains(line, "符号链接") || !strings.Contains(line, filepath.Join(Dir, "logo.svg")) {
		t.Fatalf("素材告警必须点名路径与形态（含链接目标）: %q", line)
	}
	// 同一素材被反复请求（每次渲染都要拿 logo）不得刷屏。
	before := strings.Count(line, "ERROR channel:")
	for i := 0; i < 5; i++ {
		_ = LogoPath(false)
	}
	if after := strings.Count(buf.String(), "ERROR channel:"); after != before {
		t.Fatalf("同一个素材病根只应出声一次: before=%d after=%d\n%s", before, after, buf.String())
	}
}
