const dingTalkDef = {
	id: "dingtalk",
	name: "钉钉",
	description: "钉钉：日历日程、群聊消息、文档、待办、通讯录（DingTalk Workspace CLI）",
	authMode: "cli",
	auth: {
		command: "dws",
		args: [
			"auth",
			"login",
			"--device"
		],
		deviceFlow: {
			uriPattern: "https://login\\.dingtalk\\.com/oauth2/device/verify\\.htm[^\\s\\n\\r\"'<>]*",
			codePattern: "(?:授权码|user_code=|user_code：)\\s*:?\\s*([A-Z0-9][A-Z0-9-]*)"
		},
		authWaitForExit: true,
		suppressBrowser: true,
		timeoutMs: 9e5,
		statusCommand: "dws",
		statusArgs: ["auth", "status"]
	},
	examples: [
		"查询我明天的日程安排",
		"给张三发送一条钉钉消息",
		"列出我的待办事项",
		"查看团队通讯录里的同事"
	],
	mcp: [
		"calendar",
		"chat",
		"doc",
		"todo",
		"contact"
	].map((mcpId) => ({
		serverName: `dingtalk-${mcpId}`,
		transport: "streamable-http",
		urlCommand: [
			"dws",
			"mcp",
			"url",
			"get",
			mcpId
		]
	}))
};
//#endregion
export { dingTalkDef };

//# sourceMappingURL=dingtalk.js.map