// Package portal 渲染服务端公开门户页(/ 与 /portal)。
//
// 设计取舍(2026-09-10 重构):
//
//   - **纯 HTML + CSS,零脚本**:门户是全站唯一对未认证访客开放的 HTML 面,
//     CSP 为 `default-src 'none'` 且不放开 script-src。没有 JS 就没有脚本
//     注入面,首个字节即完成渲染(内网/弱网体验更好)。
//   - **动效全部用 CSS**:入场淡入上浮(逐项延迟形成节奏)、渐变光晕呼吸、
//     卡片悬停抬升与箭头位移;并遵守 `prefers-reduced-motion`。
//   - **不画 logo**:平台与品牌一律文字化(图形需要品牌素材,且手绘易失真)。
//     管理员配置了 brand logo 时才用图片,否则用文字标识。
//   - **下载链接指向本服务端**:安装包随服务端镜像发布,由
//     GET /updates/client/<file> 下发(见 internal/clientrelease),门户不需要
//     任何外网地址;管理员仍可用 portal.client_download_* 覆盖。
//   - 只依赖系统字体与内联样式,不拉任何外部资源。
package portal

import (
	"html/template"
	"strconv"
	"strings"
)

// Platform 一个客户端平台下载项。
type Platform struct {
	// Name 平台名(Windows / macOS / Linux)
	Name string
	// Meta 架构与安装包格式说明(如 "x64 · .exe 安装程序")
	Meta string
	// Note 该平台的额外提示(可空)
	Note string
	// URL 下载地址;为空表示该平台暂无可用安装包
	URL string
}

// View 门户页渲染数据。
type View struct {
	// Name 站点名(品牌显示名;缺省 PicoAide)
	Name string
	// Tagline 一句话标语
	Tagline string
	// Welcome 欢迎语(多行保留换行)
	Welcome string
	// LogoURL 管理员配置的 logo 地址(可空;为空则不出图)
	LogoURL string
	// AdminURL 管理后台入口
	AdminURL string
	// Downloads 客户端下载项(已按可用性过滤与排序)
	Downloads []Platform
	// DownloadNote 下载区补充说明
	DownloadNote string
	// Version 服务端版本(页脚,运维核对用)
	Version string
	// Channel 本部署所属渠道(页脚)
	Channel string
}

// page 门户模板(单文件内联,便于审计)。
var page = template.Must(template.New("portal").Funcs(template.FuncMap{
	"initial": initial,
	"delay":   delay,
}).Parse(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{{.Name}}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#080a0f; --bg-2:#0d1117; --panel:rgba(255,255,255,.035);
    --panel-hi:rgba(255,255,255,.07); --line:rgba(255,255,255,.09);
    --fg:#eef1f6; --muted:#98a2b3; --accent:#5b8cf7; --accent-2:#8b6cf7;
    --shadow:0 18px 50px -20px rgba(0,0,0,.75);
  }
  @media (prefers-color-scheme: light){
    :root{
      --bg:#f7f8fb; --bg-2:#eef1f7; --panel:#ffffff; --panel-hi:#f4f6fb;
      --line:#e3e7ef; --fg:#0f172a; --muted:#64748b; --accent:#2f5fe0; --accent-2:#6d4de0;
      --shadow:0 18px 44px -24px rgba(15,23,42,.28);
    }
  }
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0;min-height:100vh;background:var(--bg);color:var(--fg);
    font:15.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",
         "Hiragino Sans GB","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;overflow-x:hidden;
  }
  /* 背景光晕:两团渐变缓慢漂移,给静态页面一层"活着"的底色 */
  .aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
  .aurora i{
    position:absolute;display:block;border-radius:50%;filter:blur(90px);
    opacity:.5;animation:drift 22s ease-in-out infinite alternate;
  }
  .aurora i:nth-child(1){width:46vw;height:46vw;left:-8vw;top:-14vw;
    background:radial-gradient(circle at 40% 40%,var(--accent),transparent 68%)}
  .aurora i:nth-child(2){width:40vw;height:40vw;right:-10vw;top:-6vw;opacity:.38;
    background:radial-gradient(circle at 60% 40%,var(--accent-2),transparent 68%);
    animation-delay:-7s;animation-duration:28s}
  @keyframes drift{
    from{transform:translate3d(0,0,0) scale(1)}
    to{transform:translate3d(3vw,4vh,0) scale(1.14)}
  }
  .wrap{position:relative;z-index:1;max-width:820px;margin:0 auto;padding:60px 24px 44px}
  /* 入场:统一从下方淡入上浮,靠 --d 逐项延迟形成节奏 */
  .rise{opacity:0;transform:translateY(14px);animation:rise .62s cubic-bezier(.22,.68,.24,1) forwards;
        animation-delay:var(--d,0s)}
  @keyframes rise{to{opacity:1;transform:none}}

  .brand{display:flex;align-items:center;gap:12px;margin-bottom:34px}
  .brand .mark{width:38px;height:38px;border-radius:11px;overflow:hidden;flex:0 0 auto;
    background:linear-gradient(140deg,var(--accent),var(--accent-2));
    display:flex;align-items:center;justify-content:center;
    color:#fff;font-weight:700;font-size:17px;letter-spacing:.02em}
  .brand .mark img{width:100%;height:100%;object-fit:contain}
  .brand .name{font-size:16.5px;font-weight:640;letter-spacing:-.01em}

  h1{margin:0 0 10px;font-size:clamp(30px,5.2vw,42px);line-height:1.14;
     font-weight:700;letter-spacing:-.028em}
  .tagline{margin:0;color:var(--muted);font-size:16.5px}
  .welcome{margin:22px 0 0;white-space:pre-wrap;font-size:15px;color:var(--fg);opacity:.9;max-width:60ch}

  .cta{margin-top:32px;display:flex;flex-wrap:wrap;gap:12px}
  .btn{
    position:relative;display:inline-flex;align-items:center;gap:9px;
    padding:12px 22px;border-radius:11px;font-size:15px;font-weight:620;
    text-decoration:none;border:1px solid transparent;isolation:isolate;
    transition:transform .18s ease,box-shadow .18s ease,filter .18s ease;
  }
  .btn:active{transform:translateY(1px)}
  .btn-primary{color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2));
    box-shadow:0 10px 30px -12px color-mix(in srgb,var(--accent) 70%,transparent)}
  .btn-primary:hover{transform:translateY(-2px);filter:brightness(1.06);
    box-shadow:0 16px 38px -14px color-mix(in srgb,var(--accent) 80%,transparent)}
  .btn-ghost{color:var(--fg);border-color:var(--line);background:var(--panel)}
  .btn-ghost:hover{transform:translateY(-2px);background:var(--panel-hi)}
  .btn .arrow{transition:transform .18s ease}
  .btn:hover .arrow{transform:translateX(3px)}

  .section{margin-top:46px}
  .head{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
  .head h2{margin:0;font-size:12.5px;font-weight:680;letter-spacing:.09em;
    text-transform:uppercase;color:var(--muted)}
  .head .ver{margin-left:auto;font-size:12.5px;color:var(--muted);
    font-variant-numeric:tabular-nums}

  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media (max-width:640px){.grid{grid-template-columns:1fr}.wrap{padding:38px 18px}}
  .dl{
    position:relative;display:block;padding:20px 18px;border-radius:14px;
    background:var(--panel);border:1px solid var(--line);color:inherit;
    text-decoration:none;overflow:hidden;backdrop-filter:blur(6px);
    transition:transform .2s ease,border-color .2s ease,background .2s ease,box-shadow .2s ease;
  }
  /* 悬停时顶部掠过一道高光,替代图标的视觉反馈 */
  .dl::after{
    content:"";position:absolute;inset:0 0 auto;height:1px;
    background:linear-gradient(90deg,transparent,var(--accent),transparent);
    opacity:0;transition:opacity .25s ease;
  }
  a.dl:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--accent) 55%,var(--line));
    background:var(--panel-hi);box-shadow:var(--shadow)}
  a.dl:hover::after{opacity:1}
  .dl .k{font-size:15.5px;font-weight:640;display:flex;align-items:center;gap:8px}
  .dl .k .go{margin-left:auto;opacity:0;transform:translateX(-4px);
    transition:opacity .2s ease,transform .2s ease;color:var(--accent)}
  a.dl:hover .k .go{opacity:1;transform:none}
  .dl .m{margin-top:5px;font-size:12.5px;color:var(--muted)}
  .dl.off{opacity:.42}
  .dl.off .k{font-weight:560}

  .empty{margin-top:4px;padding:20px;border:1px dashed var(--line);border-radius:14px;
    background:var(--panel);color:var(--muted);font-size:14px}
  .note{margin:14px 0 0;font-size:12.5px;color:var(--muted)}

  footer{margin-top:52px;padding-top:22px;border-top:1px solid var(--line);
    display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;
    font-size:12.5px;color:var(--muted)}
  footer .sp{flex:1}
  code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    background:var(--panel-hi);border:1px solid var(--line);border-radius:5px;padding:1px 6px}

  @media (prefers-reduced-motion:reduce){
    .aurora i{animation:none}
    .rise{opacity:1;transform:none;animation:none}
    .btn,.dl,.btn .arrow,.dl .k .go{transition:none}
  }
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><i></i><i></i></div>
<div class="wrap">

  <div class="brand rise" style="--d:.02s">
    <span class="mark">{{if .LogoURL}}<img src="{{.LogoURL}}" alt="">{{else}}{{initial .Name}}{{end}}</span>
    <span class="name">{{.Name}}</span>
  </div>

  <header>
    <h1 class="rise" style="--d:.08s">{{.Name}}</h1>
    {{if .Tagline}}<p class="tagline rise" style="--d:.14s">{{.Tagline}}</p>{{end}}
    {{if .Welcome}}<p class="welcome rise" style="--d:.2s">{{.Welcome}}</p>{{end}}
    <div class="cta rise" style="--d:.26s">
      <a class="btn btn-primary" href="{{.AdminURL}}">进入管理后台<span class="arrow">→</span></a>
    </div>
  </header>

  <section class="section">
    <div class="head rise" style="--d:.32s">
      <h2>客户端下载</h2>
      {{if .Version}}<span class="ver">v{{.Version}}</span>{{end}}
    </div>
    {{if .Downloads}}
      <div class="grid">
        {{range $i, $p := .Downloads}}
        {{if $p.URL}}
        <a class="dl rise" style="--d:{{delay $i}}.s" href="{{$p.URL}}">
          <span class="k">{{$p.Name}}<span class="go">↓</span></span>
          <span class="m">{{$p.Meta}}</span>
        </a>
        {{else}}
        <span class="dl off rise" style="--d:{{delay $i}}.s">
          <span class="k">{{$p.Name}}</span>
          <span class="m">{{$p.Meta}}</span>
        </span>
        {{end}}
        {{end}}
      </div>
      {{if .DownloadNote}}<p class="note rise" style="--d:.62s">{{.DownloadNote}}</p>{{end}}
    {{else}}
      <div class="empty rise" style="--d:.38s">本服务端暂未提供客户端安装包。请联系管理员确认服务端镜像版本。</div>
    {{end}}
  </section>

  <footer class="rise" style="--d:.68s">
    <span>PicoAide Harness{{if .Version}} · v{{.Version}}{{end}}</span>
    {{if .Channel}}<span>渠道 <code>{{.Channel}}</code></span>{{end}}
    <span class="sp"></span>
    <span>安装包由本服务端直接提供</span>
  </footer>
</div>
</body>
</html>
`))

// delay 返回下载项入场延迟(秒,1 位小数),逐项递增形成节奏:
// 起始 0.38s,每项 +0.07s。
func delay(index int) string {
	return strconv.FormatFloat(0.38+float64(index)*0.07, 'f', 2, 64)
}

// initial 取名称首字符做文字标识(不画 logo:图形需品牌素材,文字更稳)。
func initial(name string) string {
	for _, r := range strings.TrimSpace(name) {
		return strings.ToUpper(string(r))
	}
	return "P"
}

// Render 渲染门户页 HTML。
// @param v - 渲染数据(空字段自动省略对应区块)。
// @returns HTML 字符串;模板异常时返回可读兜底页(门户不可 500)。
func Render(v View) string {
	var b strings.Builder
	if err := page.Execute(&b, v); err != nil {
		esc := template.HTMLEscapeString
		return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>` +
			esc(v.Name) + `</title></head><body><h1>` + esc(v.Name) + `</h1>` +
			`<p><a href="` + esc(v.AdminURL) + `">进入管理后台</a></p></body></html>`
	}
	return b.String()
}
