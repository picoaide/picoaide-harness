import type { ConnectorDef } from '../types.ts'
import { def as _77ircloudDef } from './77ircloud.ts'
import { def as ai_hiveDef } from './ai-hive.ts'
import { def as awesunDef } from './awesun.ts'
import { def as beisen_cliDef } from './beisen-cli.ts'
import { def as cloudbaseDef } from './cloudbase.ts'
import { def as cnb_apiDef } from './cnb-api.ts'
import { def as dingtalkDef } from './dingtalk.ts'
import { def as emr_queryDef } from './emr-query.ts'
import { def as feishuDef } from './feishu.ts'
import { def as lemonclawDef } from './lemonclaw.ts'
import { def as lovrabet_cliDef } from './lovrabet-cli.ts'
import { def as mglcDef } from './mglc.ts'
import { def as miaodaDef } from './miaoda.ts'
import { def as seeyon_office_marketing_suiteDef } from './seeyon-office-marketing-suite.ts'
import { def as shanlong_clawDef } from './shanlong-claw.ts'
import { def as tc_chengxinDef } from './tc-chengxin.ts'
import { def as tencentadsDef } from './tencentads.ts'
import { def as textin_xparseDef } from './textin-xparse.ts'
import { def as tmeetDef } from './tmeet.ts'
import { def as wecomDef } from './wecom.ts'
import { def as woscliDef } from './woscli.ts'
import { def as wps_knowledgebaseDef } from './wps-knowledgebase.ts'
import { def as zsxqDef } from './zsxq.ts'
import { def as bugly_tokenDef } from './bugly-token.ts'
import { def as cisp_mcpDef } from './cisp-mcp.ts'
import { def as ctrip_wendaoDef } from './ctrip-wendao.ts'
import { def as fazhi_lawDef } from './fazhi-law.ts'
import { def as gangtise_mcpDef } from './gangtise-mcp.ts'
import { def as gildataDef } from './gildata.ts'
import { def as infimind_ecommerce_imageDef } from './infimind-ecommerce-image.ts'
import { def as infimind_videoDef } from './infimind-video.ts'
import { def as kuaicha_searchDef } from './kuaicha-search.ts'
import { def as lingxing_mcpDef } from './lingxing-mcp.ts'
import { def as linkfox_product_selectionDef } from './linkfox-product-selection.ts'
import { def as netease_mailDef } from './netease-mail.ts'
import { def as opendataDef } from './opendata.ts'
import { def as patsnap_searchDef } from './patsnap-search.ts'
import { def as picset_commerce_imagesDef } from './picset-commerce-images.ts'
import { def as picset_video_generationDef } from './picset-video-generation.ts'
import { def as sq_company_dynamicDef } from './sq-company-dynamic.ts'
import { def as tencent_mapDef } from './tencent-map.ts'
import { def as weisheng_scrmDef } from './weisheng-scrm.ts'
import { def as wind_financeDef } from './wind-finance.ts'
import { def as yingmi_mcpDef } from './yingmi-mcp.ts'
import { def as youshu_bd_mateDef } from './youshu-bd-mate.ts'
import { def as zfs_fssc_aiDef } from './zfs-fssc-ai.ts'
import { def as agentkeyDef } from './agentkey.ts'
import { def as archive_hospital_mcpDef } from './archive-hospital-mcp.ts'
import { def as bazhuayuDef } from './bazhuayu.ts'
import { def as canvaDef } from './canva.ts'
import { def as canva_aiDef } from './canva-ai.ts'
import { def as chuhaijiangDef } from './chuhaijiang.ts'
import { def as dknowc_mcpDef } from './dknowc-mcp.ts'
import { def as edgeone_pagesDef } from './edgeone-pages.ts'
import { def as ezjoin_meetingDef } from './ezjoin-meeting.ts'
import { def as fbs_connectorDef } from './fbs-connector.ts'
import { def as fyopen_lawsearchDef } from './fyopen-lawsearch.ts'
import { def as github_remoteDef } from './github-remote.ts'
import { def as gmailDef } from './gmail.ts'
import { def as gongyi_open_mcpDef } from './gongyi-open-mcp.ts'
import { def as ima_mcpDef } from './ima-mcp.ts'
import { def as jiraDef } from './jira.ts'
import { def as jiushuyunDef } from './jiushuyun.ts'
import { def as kling_aiDef } from './kling-ai.ts'
import { def as lexiangDef } from './lexiang.ts'
import { def as mastergo_vibe_mcpDef } from './mastergo-vibe-mcp.ts'
import { def as mokaDef } from './moka.ts'
import { def as morningstarDef } from './morningstar.ts'
import { def as mx_ds_mcpDef } from './mx-ds-mcp.ts'
import { def as mzl_trademarkDef } from './mzl-trademark.ts'
import { def as neo_crmDef } from './neo-crm.ts'
import { def as notionDef } from './notion.ts'
import { def as pandadataDef } from './pandadata.ts'
import { def as pkulawDef } from './pkulaw.ts'
import { def as qcc_companyDef } from './qcc-company.ts'
import { def as qcc_legalDef } from './qcc-legal.ts'
import { def as qingflowDef } from './qingflow.ts'
import { def as qixinhuiyan_mcpDef } from './qixinhuiyan-mcp.ts'
import { def as qq_mailDef } from './qq-mail.ts'
import { def as salesnail_instructorDef } from './salesnail-instructor.ts'
import { def as salestouchDef } from './salestouch.ts'
import { def as shanglv_mcp_gatewayDef } from './shanglv-mcp-gateway.ts'
import { def as sharecrmDef } from './sharecrm.ts'
import { def as supabaseDef } from './supabase.ts'
import { def as tapdDef } from './tapd.ts'
import { def as tec_doDef } from './tec-do.ts'
import { def as tencent_docsDef } from './tencent-docs.ts'
import { def as tencent_health_ngesDef } from './tencent-health-nges.ts'
import { def as tencent_surveyDef } from './tencent-survey.ts'
import { def as tencent_tchouse_cDef } from './tencent-tchouse-c.ts'
import { def as tencent_weiyunDef } from './tencent-weiyun.ts'
import { def as tongzhou_fin_researchDef } from './tongzhou-fin-research.ts'
import { def as tyc_mcpDef } from './tyc-mcp.ts'
import { def as westock_mcpDef } from './westock-mcp.ts'
import { def as wk_workbuddyDef } from './wk-workbuddy.ts'
import { def as xiaoe_cloud_cliDef } from './xiaoe-cloud-cli.ts'
import { def as yuandian_mcpDef } from './yuandian-mcp.ts'
import { def as yzf_invoice_mcp_serverDef } from './yzf-invoice-mcp-server.ts'

/** All marketplace-generated connector definitions. */
export const marketplaceDefs: ConnectorDef[] = [
  _77ircloudDef,
  ai_hiveDef,
  awesunDef,
  beisen_cliDef,
  cloudbaseDef,
  cnb_apiDef,
  dingtalkDef,
  emr_queryDef,
  feishuDef,
  lemonclawDef,
  lovrabet_cliDef,
  mglcDef,
  miaodaDef,
  seeyon_office_marketing_suiteDef,
  shanlong_clawDef,
  tc_chengxinDef,
  tencentadsDef,
  textin_xparseDef,
  tmeetDef,
  wecomDef,
  woscliDef,
  wps_knowledgebaseDef,
  zsxqDef,
  bugly_tokenDef,
  cisp_mcpDef,
  ctrip_wendaoDef,
  fazhi_lawDef,
  gangtise_mcpDef,
  gildataDef,
  infimind_ecommerce_imageDef,
  infimind_videoDef,
  kuaicha_searchDef,
  lingxing_mcpDef,
  linkfox_product_selectionDef,
  netease_mailDef,
  opendataDef,
  patsnap_searchDef,
  picset_commerce_imagesDef,
  picset_video_generationDef,
  sq_company_dynamicDef,
  tencent_mapDef,
  weisheng_scrmDef,
  wind_financeDef,
  yingmi_mcpDef,
  youshu_bd_mateDef,
  zfs_fssc_aiDef,
  agentkeyDef,
  archive_hospital_mcpDef,
  bazhuayuDef,
  canvaDef,
  canva_aiDef,
  chuhaijiangDef,
  dknowc_mcpDef,
  edgeone_pagesDef,
  ezjoin_meetingDef,
  fbs_connectorDef,
  fyopen_lawsearchDef,
  github_remoteDef,
  gmailDef,
  gongyi_open_mcpDef,
  ima_mcpDef,
  jiraDef,
  jiushuyunDef,
  kling_aiDef,
  lexiangDef,
  mastergo_vibe_mcpDef,
  mokaDef,
  morningstarDef,
  mx_ds_mcpDef,
  mzl_trademarkDef,
  neo_crmDef,
  notionDef,
  pandadataDef,
  pkulawDef,
  qcc_companyDef,
  qcc_legalDef,
  qingflowDef,
  qixinhuiyan_mcpDef,
  qq_mailDef,
  salesnail_instructorDef,
  salestouchDef,
  shanglv_mcp_gatewayDef,
  sharecrmDef,
  supabaseDef,
  tapdDef,
  tec_doDef,
  tencent_docsDef,
  tencent_health_ngesDef,
  tencent_surveyDef,
  tencent_tchouse_cDef,
  tencent_weiyunDef,
  tongzhou_fin_researchDef,
  tyc_mcpDef,
  westock_mcpDef,
  wk_workbuddyDef,
  xiaoe_cloud_cliDef,
  yuandian_mcpDef,
  yzf_invoice_mcp_serverDef,
]
