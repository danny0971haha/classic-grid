# PR15 A/B 工程結案核對材料

本件是主執行者的平行唯讀實作協作自查，不是正式獨立接受審查，不宣告 ACCEPT 或任何 merge、部署、交易授權。只核對 `danny0971haha/classic-grid`。本分工結果：既有 A/B 證據足夠結束該工程修正核對；`NO_NEW_CODE_CHANGE_REQUIRED`。root audit 與 scoped tool＋target 的最終分項由整合報告另列。

## 實際身分與不變範圍

讀取了實際 `AGENTS.md`、`AI_START_HERE.md`、`docs/CURRENT_STATUS.md`、`docs/IMPLEMENTATION_EVIDENCE.md`、既有 archive README/verifier、inventory tests/policy、E/F verifier 及 dependency-boundary generator。核對工作樹 `/private/tmp/classic-ci-inventory-evidence-20260909` 為乾淨，HEAD `ff3d896c427c3d0ca2833879655157029040e044`，tree `fb693000a7ea157b0995ee9b58592c53ce072419`。PR15 base `40223bb5e106668e2d5a2c8971579b41e7a9dbfa` 的 tree 是 `c99180aab2b4cf9b4abb40780c7d2192686d9eec`。

PR15 diff 只涉及兩份 inventory tests 與既有 47-file 歷史資料封裝。`ab-checks/preservation.stdout.json` 記錄 base/head Git object 相等：兩份 workflow、`scripts/security` 整棵樹（含 allowlist、Action policy、audit policy/baseline/verifier）、root package/lock、bounded canary 全目錄、`src`、`vendor`、`tools`。因此未放寬 Action 或 audit 政策、workflow 或觸發條件，也未修改 runtime/dependency。資料封裝的刪除路徑是原檔納入 archive，不是歷史 bytes 遺失。

## A：精確 inventory 與負例

兩份既有測試都用 `deepEqual` 精確檢查 tracked/scanned manifests 僅 `.github/workflows/ci.yml` 及 `.github/workflows/classic-canary-scoped.yml`，並精確檢查以下完整 7 個 `[file, identity, ref]` tuple 的順序與重數：

| Workflow | 次數 | Action identity | 完整 ref |
| --- | ---: | --- | --- |
| ci.yml | 1 | actions/checkout | 11d5960a326750d5838078e36cf38b85af677262 |
| ci.yml | 1 | actions/setup-node | 49933ea5288caeca8642d1e84afbd3f7d6820020 |
| ci.yml | 4 | actions/upload-artifact | ea165f8d65b6e75b540449e92b4886f43607fa02 |
| classic-canary-scoped.yml | 1 | actions/upload-artifact | ea165f8d65b6e75b540449e92b4886f43607fa02 |

來源為 PR15 `test/security/action-pin.test.ts:258` 與 `test/security/action-trust-git.test.ts:370`。後者 `:344` 的既有真實 scoped workflow 負例先確認 approved workflow 有效，再只替換其唯一 upload Action。`v4` 被 `ACTION_NOT_ALLOWLISTED` 與 `ACTION_REF_NOT_IMMUTABLE` 拒絕；40hex `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` 仍被 `ACTION_NOT_ALLOWLISTED` 拒絕，且其 immutablePin=true，不會將格式正確誤當 allowlisted。

優先沿用既有 regression：`classic-ci-inventory-evidence-results-20260909/inventory-tests-final/{command.json,stdout,stderr}` 記錄 34/34、exit 0。本輪下載的 security artifact `10090041028/security/security-checker-tests.log` 再確認相同兩個精確 inventory 與兩個反例均 `ok`（第 81–82、196–209 行），整個 checker 227/227、fail 0（1498–1501 行）。沒有重跑測試套件或新 CI。

## B：47-file 歷史 archive 保全

沿用既有 `verify_archive.py restore --git-source . --destination .../independently-restored` 完成證據：2026-09-09 05:33:06–05:33:07 UTC，exit 0。該 verifier 已拒絕 unsafe/duplicate/link/special paths、異常模式或大小、缺檔、hash/blob/source-tree 不符，並驗證原始 manifest。

本輪重新讀取既有 archive/verifier bytes，呼叫其既有 `verify_package` 與 `verify_archive(..., git_source)`，且直接核對已存在的 restored 目錄，不重新封裝或還原歷史資料。確認：47 個 exact path、313,383 file bytes、所有原 Git mode `100644`／filesystem mode `0644`、SHA256、Git blob、來源 Git 原始 bytes 與清單全部一致。原 SHA256SUMS 的 45 entries 原樣保留；其自身與 `identity-after-packet.txt` 由新的 47-file manifest 涵蓋。archive SHA256 為 `aa60ca2154db0d0b49f14c2093932049be70255624b65d72f77262cb2cae7c38`。

現有 verification 與逐檔 restored readback exit 0，完整命令、時間、結果在 `ab-checks/preservation.command.json`、`preservation.stdout.json`、`preservation.stderr.txt`。本輪未重做測試、未重封裝歷史 archive。

## 下載後 E/F 與其他 CI artifacts

CI run `34315427266` 的四個下載 ZIP 的 SHA256 全部等於目前 remote artifact metadata 所列 digest，artifact workflow_run 都綁定 PR15 HEAD。又逐項比對 ZIP 內 member bytes 與解包後檔案、無多檔或缺檔：E 1 檔、F 1 檔、security 12 檔、dependency-boundary 1 檔。這不是只核對上傳前資料夾。

下載 E/F JSON 分別直接交由 PR15 原有 `verifyEvidence` exports 核對，exit 0，沒有執行 generate 或 test suites。expected identity 使用已核對 Git object 與原始 CI log；另以 `deepEqual` 核对所有 identity 欄位，required file hashes 取自當前乾淨 PR15 tree。CLI `verifyEvidenceFile` 會自行解析本地 checkout identity，因此本輪使用其底層同一 existing verifier API，沒有偽造 GitHub 環境或把本機 HEAD 說成 PR merge checkout。

| 身分欄位 | 下載後核對結果 |
| --- | --- |
| sourceHeadSha | ff3d896c427c3d0ca2833879655157029040e044 |
| sourceHeadTreeSha | fb693000a7ea157b0995ee9b58592c53ce072419 |
| testedCheckoutSha | 91cf2a5bd4382185236dc45b20cb5da60d117052 |
| testedCheckoutTreeSha | fb693000a7ea157b0995ee9b58592c53ce072419 |
| baseSha | 40223bb5e106668e2d5a2c8971579b41e7a9dbfa |
| event / run / attempt / job | pull_request / 34315427266 / 1 / compiler-and-tests |
| CI toolchain | Node v22.23.2 / npm 10.9.8 |
| E | 30 checkpoint cases、696 project cases；原 verifier 檢查 counts/exits/commands/file hashes |
| F | 40 checkpoint cases、696 project cases；另核對 recorded trees 的真實 Git objects |

E JSON SHA256 `061c98fbcad77f9bcc9aaa20d3075402e16264d5aa48ebd76c01a3cf3808f520`；F JSON SHA256 `2a726ab0d17893025b5bf6e396041ed1600f11ff96ad67c1a69d879f59a8ef8a`。

Dependency-boundary 下載 JSON 的 canonical body digest `ef2dfae6d40e8946ae85934cbce83c799e6929679af7bc6022ab13154aea2cc8` 重新計算相符；result SHA/tree 是上述 PR merge checkout。其 historical `baseSha=514853fd480d915491595fca4a73667087b9e3b9` 的 tree 也以 Git 核對；它不是 PR15 base 欄位。root/canary lockfile hash 與乾淨 PR15 files 相符；artifact SHA、loaded module inventory、forbiddenLoaded、audit counts 與同次下載 security JSON 逐欄相符。記錄 full 696/696、E 30/30、F 40/40、security 83/83、四命令 exits 0。root audit high 16 與 canary high 0 分開保留。此 JSON 的 generation command 本輪沒有執行。

下載核對腳本與記錄：`ab-checks/verify-downloaded.mjs`、`downloaded.command.json`、`downloaded.stdout.json`、`downloaded.stderr.txt`。本輪 local verification Node 為 v22.23.2。artifact record/交叉比對本身不替代 scoped Linux run 的實際打包、安裝、載入和核心隔離證據；CI PR15 也不冒充既有固定 target 的被測身分。

## 限制、缺陷與執行界線

- 未重現 inventory、archive verifier 或既有 canary tooling 的新缺陷；沒有 corrective branch、code commit、Draft PR 或新 CI。`NO_NEW_CODE_CHANGE_REQUIRED`。
- 本輪只新增 repo 外部本核對報告與 verifier invocation records，repo 保持乾淨。未修改任何 refs、使用者工作樹、套件、lockfile 或政策。
- 核對輔助程式初次錯把不存在的 `security` 路徑列入 Git object compare，exit 1／Git exit 128；這是本轮只读脚本輸入筆誤，改為實際存在的 `scripts/security` 後完整核對 exit 0。未將此筆誤列成產品缺陷，也未因此修改 repo。
- 未執行 registry install/audit、exchange access、credentials load、任何 testnet/mainnet write、merge、rebase/force-push、部署或交易階段啟動。
- 此分工沒有單獨裁定 job/workflow 結論或 owner Route B adoption；整合報告必須保留 root audit 的拒絕、CI continue-on-error 的原始 outcome、固定 scoped tool/target 身分及正式獨立審查未執行的界線。
