# WORKORDER U5 Report

日期: 2026-07-06
分支: `v3-session`
提交: 未 commit、未 push

## 完成項目

- `src/agent/sessions.js`
  - owner 發起 session topic 下限改為 5 字。
  - agent 發起 session topic 下限維持 20 字。
  - topic 長度、participant 未註冊、budget 格式、repo 解析失敗改為帶 `code`/`details` 的 session validation error。

- `src/agent/dashboard/commands.js`
  - `/session` catch 不再吞 validation error；可辨識錯誤回第一行繁中具體原因、第二行用法。
  - 無 code 的 parser fallback 維持原本只回 `/session` 用法。
  - 新增 `/model`：
    - 無參數顯示 opus/codex runner model。
    - `/model opus <值>` 寫 `exchange_runner_model`。
    - `/model codex <值>` 寫 `codex_runner_model`。
    - 修改走既有 `setTelegramCodexPolicy` 驗證；驗證失敗回具體錯誤。
  - `dashboardHint` 加上 `/model`。

- `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md`
  - `topic` spec 改為 `owner 5–500 字;agent 發起 20–500 字`。

- Tests
  - dashboard `/session` 錯誤映射覆蓋 topic 長度、participant 未註冊、budget 格式、repo 解析失敗，斷言含具體數字/名單/原因。
  - session core 覆蓋 owner 5 字 topic 成功、agent 5 字 topic 被拒。
  - dashboard `/model` 覆蓋顯示、owner 修改後 config 檔落盤、非 owner 拒絕、驗證失敗訊息。

## 自審

- Scope: tracked 變更限於 U5 指定實作檔、spec 一行、對應測試與本報告。
- `docs/history/WORKORDER_U5.md` 目前是 untracked 工單檔；本次未修改。
- `git diff --check`: pass。

## 驗證

```
npm test
```

結果: pass,18/18 test files。
