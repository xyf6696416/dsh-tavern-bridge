// dsh-tavern-bridge — 桌面 GUI 客户端模块
// 在 dsh 设置页注册「酒馆中转」一节：显示监听地址与口令，一键复制。
//
// 打包形态：window.__ModuleLoader__.load({ id, factory })（dsh-client-modules 约定）。
// 手写 React.createElement，无 JSX / 构建链；依赖由 dsh 客户端运行时提供。
//
// 数据来源：中转插件自建的 HTTP 监听（默认 127.0.0.1:57421，端口占用会往后漂）。
// 因为插件不挂 dsh 的 webServer，这里按端口段探测——找到第一个回 status 的就是它。
// 跨端口请求靠插件侧的 CORS 头放行。

window.__ModuleLoader__.load({
	id: "dsh-tavern-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");

		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;

		/** 所需服务：slots（设置页 slot 注册）。 */
		exports.inject = ["slots"];

		/** 探测端口段：默认端口 + 插件 portFallback 最多往后 20 个。 */
		var PORT_BASE = 57421;
		var PORT_SPAN = 21;
		var LS_PORT = "dsh-tavern-bridge-port";

		var rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			padding: "10px 0",
			borderBottom: "1px solid var(--dsw-alias-divider-strong, rgba(128,128,128,.18))",
			fontSize: "13.5px",
		};
		var btnStyle = {
			marginLeft: "auto",
			flex: "none",
			padding: "4px 12px",
			borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.35))",
			background: "none",
			cursor: "pointer",
			font: "inherit",
			fontSize: "12px",
			color: "inherit",
		};
		var codeStyle = {
			wordBreak: "break-all",
			fontFamily: "monospace",
			fontSize: "12.5px",
		};
		var mutedStyle = {
			fontSize: "12.5px",
			color: "var(--dsw-alias-label-secondary, #888)",
			lineHeight: "1.7",
		};

		function toast(text) {
			var el = document.getElementById("dsh-tb-toast");
			if (!el) {
				el = document.createElement("div");
				el.id = "dsh-tb-toast";
				el.style.cssText =
					"position:fixed;left:50%;bottom:48px;transform:translateX(-50%);" +
					"background:rgba(31,35,41,.92);color:#fff;border-radius:999px;" +
					"padding:8px 16px;font-size:13px;z-index:9999;opacity:0;" +
					"transition:opacity .2s;pointer-events:none;";
				document.body.appendChild(el);
			}
			el.textContent = text;
			el.style.opacity = "1";
			clearTimeout(el._t);
			el._t = setTimeout(function () {
				el.style.opacity = "0";
			}, 1600);
		}

		/** 复制：优先 Clipboard API，回退 execCommand（http 页面下前者常不可用）。 */
		function copyText(text) {
			if (!text) return;
			var done = function () {
				toast("已复制");
			};
			try {
				if (navigator.clipboard && window.isSecureContext) {
					navigator.clipboard.writeText(text).then(done, function () {
						fallbackCopy(text, done);
					});
					return;
				}
			} catch (e) {
				/* 落到回退分支 */
			}
			fallbackCopy(text, done);
		}

		function fallbackCopy(text, done) {
			try {
				var ta = document.createElement("textarea");
				ta.value = text;
				ta.style.cssText = "position:fixed;left:-9999px;top:0;";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				done();
			} catch (e) {
				toast("复制失败，请手动选中");
			}
		}

		/** 按端口段找中转服务；上次成功的端口优先试。 */
		async function probe() {
			var order = [];
			try {
				var last = Number(localStorage.getItem(LS_PORT));
				if (last >= 1 && last <= 65535) order.push(last);
			} catch (e) {
				/* 忽略 */
			}
			for (var i = 0; i < PORT_SPAN; i++) {
				var p = PORT_BASE + i;
				if (order.indexOf(p) < 0) order.push(p);
			}

			for (var j = 0; j < order.length; j++) {
				var port = order[j];
				var ctrl = new AbortController();
				var hit = await fetchOne(port, ctrl);
				if (hit) return hit;
			}
			return null;
		}

		/** 探一个端口。注意 ctrl/timer 必须每次新建（用 var 会被循环共享）。 */
		async function fetchOne(port, ctrl) {
			var timer = setTimeout(function () {
				ctrl.abort();
			}, 900);
			try {
				var r = await fetch("http://127.0.0.1:" + port + "/bridge/api/status", {
					signal: ctrl.signal,
				});
				clearTimeout(timer);
				if (!r.ok) return null;
				var data = await r.json();
				if (!data || !data.ok) return null;
				try {
					localStorage.setItem(LS_PORT, String(port));
				} catch (e) {
					/* 忽略 */
				}
				return { port: port, status: data };
			} catch (e) {
				clearTimeout(timer);
				return null;
			}
		}

		function Row(props) {
			return jsxRuntime.jsx("div", { style: rowStyle, children: props.children });
		}

		function CopyBtn(props) {
			return jsxRuntime.jsx("button", {
				style: btnStyle,
				onClick: function () {
					// 口令不放进状态轮询里，点了才去拉完整值
					if (props.tokenPath) {
						fetch("http://127.0.0.1:" + props.port + props.tokenPath)
							.then(function (r) {
								return r.json();
							})
							.then(function (d) {
								if (d && d.token) copyText(d.token);
								else toast("未设置口令");
							})
							.catch(function () {
								toast("读取失败");
							});
						return;
					}
					copyText(props.value);
				},
				children: props.label || "复制",
			});
		}

		/** 设置页 section 组件。 */
		function TavernSection() {
			var _useState = useState({ loading: true, found: null, error: "" });
			var st = _useState[0];
			var setSt = _useState[1];

			var refresh = useCallback(function () {
				probe().then(
					function (found) {
						setSt({ loading: false, found: found, error: "" });
					},
					function (e) {
						setSt({ loading: false, found: null, error: String((e && e.message) || e) });
					}
				);
			}, []);

			useEffect(
				function () {
					refresh();
					var timer = setInterval(refresh, 5000);
					return function () {
						clearInterval(timer);
					};
				},
				[refresh]
			);

			if (st.loading) {
				return jsxRuntime.jsx("div", { style: mutedStyle, children: "正在查找中转服务…" });
			}

			if (!st.found) {
				return jsxRuntime.jsx("div", {
					style: { display: "flex", flexDirection: "column", gap: "8px", padding: "4px 0 16px" },
					children: [
						jsxRuntime.jsx("div", {
							style: {
								padding: "10px 12px",
								borderRadius: "8px",
								background: "rgba(229,72,77,.12)",
								border: "1px solid rgba(229,72,77,.4)",
								color: "var(--dsw-alias-text-danger, #e5484d)",
								fontSize: "12.5px",
								lineHeight: "1.6",
							},
							children:
								"没找到中转服务（已探测 " +
								PORT_BASE +
								"–" +
								(PORT_BASE + PORT_SPAN - 1) +
								"）。检查插件是否启用，或看 dsh 日志里的 tavern-bridge 行。",
						}),
						jsxRuntime.jsx("button", {
							style: Object.assign({}, btnStyle, { marginLeft: 0, padding: "6px 14px" }),
							onClick: refresh,
							children: "重新查找",
						}),
					],
				});
			}

			var s = st.found.status;
			var apiUrl = s.url || "http://127.0.0.1:" + st.found.port + "/v1";

			return jsxRuntime.jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "2px", padding: "4px 0 16px" },
				children: [
					jsxRuntime.jsx("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0 8px" },
						children: [
							jsxRuntime.jsx("span", {
								style: {
									display: "inline-block",
									width: 8,
									height: 8,
									borderRadius: 4,
									background: s.listening ? "#30a46c" : "#e5484d",
								},
							}),
							jsxRuntime.jsx("span", {
								style: { fontSize: "13px", fontWeight: 600 },
								children: s.listening ? "运行中" : "未监听",
							}),
							jsxRuntime.jsx("span", {
								style: mutedStyle,
								children: "端口 " + s.port + (s.port !== PORT_BASE ? "（默认端口被占用，已自动后移）" : ""),
							}),
						],
					}),

					jsxRuntime.jsx(Row, {
						children: [
							jsxRuntime.jsx("span", { style: { flex: "0 0 76px", color: "var(--dsw-alias-label-secondary, #888)" }, children: "API 地址" }),
							jsxRuntime.jsx("span", { style: codeStyle, children: apiUrl }),
							jsxRuntime.jsx(CopyBtn, { value: apiUrl }),
						],
					}),

					jsxRuntime.jsx(Row, {
						children: [
							jsxRuntime.jsx("span", { style: { flex: "0 0 76px", color: "var(--dsw-alias-label-secondary, #888)" }, children: "秘钥" }),
							jsxRuntime.jsx("span", {
								style: { fontFamily: "monospace", fontSize: "12.5px", opacity: s.hasToken ? 1 : 0.7 },
								children: s.hasToken ? s.token : "未启用（随便填）",
							}),
							s.hasToken
								? jsxRuntime.jsx(CopyBtn, { tokenPath: "/bridge/api/token", port: st.found.port })
								: jsxRuntime.jsx("span", { style: mutedStyle, children: "酒馆的 API Key 填任意字符即可" }),
						],
					}),

					jsxRuntime.jsx(Row, {
						children: [
							jsxRuntime.jsx("span", { style: { flex: "0 0 76px", color: "var(--dsw-alias-label-secondary, #888)" }, children: "工作区" }),
							jsxRuntime.jsx("span", { style: Object.assign({}, codeStyle, { fontFamily: "inherit", fontSize: "12.5px" }), children: s.workspace || "—" }),
							s.workspace ? jsxRuntime.jsx(CopyBtn, { value: s.workspace }) : null,
						],
					}),

					jsxRuntime.jsx(Row, {
						children: [
							jsxRuntime.jsx("span", { style: { flex: "0 0 76px", color: "var(--dsw-alias-label-secondary, #888)" }, children: "预设 / 模型" }),
							jsxRuntime.jsx("span", {
								style: { fontSize: "12.5px" },
								children: s.agentPreset + " · " + s.model + " · 思考 " + s.reasoningEffort,
							}),
						],
					}),

					jsxRuntime.jsx("div", {
						style: Object.assign({}, mutedStyle, { marginTop: "10px", borderTop: "1px solid rgba(128,128,128,.15)", paddingTop: "10px" }),
						children: [
							jsxRuntime.jsx("div", { style: { fontWeight: 600, marginBottom: "4px", color: "inherit" }, children: "酒馆里怎么填" }),
							jsxRuntime.jsx("div", {
								children:
									"聊天补全来源选「自定义 (OpenAI 兼容)」，Custom Endpoint 填上面的 API 地址（末尾带 /v1，不要带 /chat/completions），模型名填 " +
									s.model +
									"，API Key 随便填。",
							}),
							jsxRuntime.jsx("div", {
								style: { marginTop: "6px" },
								children:
									"端口变了也不用手动改：这里显示的就是当前实际地址，复制即可。本轮成功处理 " +
									(s.turns || 0) +
									" 次" +
									(s.lastTurnMs ? "，上一轮耗时 " + (s.lastTurnMs / 1000).toFixed(1) + "s" : "") +
									"。",
							}),
						],
					}),
				],
			});
		}

		/** 注册设置页 section（id: tavern-bridge）。 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "tavern-bridge",
						order: 95,
						label: "酒馆中转",
					},
					TavernSection
				);
			});
		}

		exports.apply = apply;
		return module.exports;
	},
});
