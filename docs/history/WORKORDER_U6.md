# 工單 U6 — 看板指令容錯(給 Codex)

owner 實測回饋兩條,範圍鎖死在 `src/agent/dashboard/commands.js` + 對應測試,其他不碰。

## 1. /session 分隔符容錯 + 剩餘無 code 錯誤補齊
- 手機鍵盤會把 `--` 自動修正成 em dash。分隔符除了 ` -- ` 也要接受 ` — `(U+2014)和 ` – `(U+2013),前後有空白才算(避免誤切題目內文)。
- `parseSessionCommand` 裡還沒 code 的錯誤全部補上 code+details 並在 `describeSessionError` 映射繁中訊息:
  - `missing_topic_separator` → 「找不到題目分隔符,參與者後面接 ` -- `(兩個減號)再接題目;直接打 — 也可以」
  - `missing_participants` → 「缺參與者,範例:/session codex,opus -- 題目」
  - `bad_option`(帶 details.option)→ 「看不懂的選項:<option>,可用:repo= budget= write=」
- repo 維持選配不變(純討論不帶 repo 本來就合法,不要動這段)。

## 2. /model 目標改名 claude/codex
- 顯示(無參數):`claude runner(信箱名 opus): <exchange_runner_model>` 與 `codex runner: <codex_runner_model 或 '(codex CLI 預設)'>`。
- 設定:`/model claude <值>`、`/model codex <值>`;`opus` 收為 `claude` 的別名(照收不報錯)。用法字串同步改。

## 測試(真行為+真斷言)
em dash 與 en dash 分隔的 /session 成功開場;三個新錯誤 code 的訊息映射;`/model claude sonnet` 改到 exchange_runner_model;`/model opus x` 別名等效。npm test 全綠才交。報告寫 docs/history/WORKORDER_U6_REPORT.md。不 commit 不 push。
