# Classic canary driver 修正與 Linux 補驗交付

本文件是具體執行證據，供獨立審閱；不宣告接受、合併或交易授權。只處理 `danny0971haha/classic-grid`。

## 分支、PR 與被測身分

- 程式 branch：`fix/classic-canary-driver-20260909`。
- [Draft PR #14](https://github.com/danny0971haha/classic-grid/pull/14)，base 為 `fix/classic-audit-output-path-20260906`，沒有改寫 #12/#13。
- 程式 HEAD：`40223bb5e106668e2d5a2c8971579b41e7a9dbfa`；tree：`c99180aab2b4cf9b4abb40780c7d2192686d9eec`。
- 原始 TOOL_HEAD：`3ca01ae046f27aa4ca74e9e8370928a48d0c7810`；tree：`c756dedb245d1560cafb8f3ea018cc0180da6244`。新程式 branch 從此建立，原 branch 與證據完整保留。
- TARGET/base HEAD：`fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf`；tree：`7f14f66eac518c4427076f18fbcfdc7d935c79d8`。
- Linux 被測 worktree：`/home/runner/work/_temp/classic-canary-target`。工具 worktree：`/home/runner/work/classic-grid/classic-grid`。測試前後兩者 HEAD/tree 一致、Git status 空白。實際 pack/policy/probe 函式由 target 路徑匯入。
- CI 證據 branch：`evidence/classic-canary-linux-20260909`，只增加本資料夾的證據；程式 HEAD 不再為嵌入 CI 證據而前進。

詳見 [前置身分](linux-artifact/scoped/identities.json)、[結束身分](linux-artifact/scoped/identities-after.json)、[遠端 publication 對帳](linux-artifact/scoped/publication.json)、[changed paths](changed-paths.txt) 與 [受保護 Git 物件比對](protected-object-identity.json)。PR 對 base 另包含原 tooling branch 已有的工具與 20260908 證據；這些歷史證據沒有被改寫。

## 修正前後

原版最小重現：命令 exit 7 使 shell 在後續診斷前停止；scanner 遇到禁止項目與缺少 install 目錄仍 exit 0。原始輸入、stdout/stderr 和時間記錄位於上層 `local/legacy-*-reproduction.json`。

修正版以各步驟的真實 exit code 和相依關係結算，必要掃描失敗會阻止 probe；獨立 tests 與最後身分診斷仍會收集。缺少輸入、錯誤 SHA、舊輸出、pins 不符、isolation 不可用都不會變成成功；未執行項使用 NOT_RUN 和 null exit code。

- 本機離線回歸：25 項，exit 0。
- Linux 同一份離線回歸：25 項，exit 0，見 [原始結果](linux-artifact/bootstrap/regressions/stderr) 與 [命令時間](linux-artifact/bootstrap/regressions/command.json)。測試中的 fake commands / fixture outcomes 只驗證 driver，不代表 canary 結果。
- 同一程式 HEAD 的實際 Darwin driver：BLOCKED、最終 exit 1；pins 與 isolation 阻塞後，publication 與結束身分診斷仍完成，相依執行全部 NOT_RUN，見 [summary](darwin-driver/summary.json)。
- 再次指定同一舊輸出目錄：exit 1，existing output 未改寫，見 [原始回傳](stale-output-invocation/stdout)。

## Linux 實際驗證

[Scoped run 34257856526](https://github.com/danny0971haha/classic-grid/actions/runs/34257856526) 的 GitHub conclusion 為 `success`；[driver summary](linux-artifact/scoped/summary.json) 為 `COMPLETED`、exit 0。這是工具及限定範圍執行結果，不是獨立接受。

實際時間為 2026-09-09 01:33–01:35（台北）；原始記錄使用 2026-09-08 17:33–17:35 UTC。

| 檢查 | 觀察 |
| --- | --- |
| 工具鏈 | Linux x86_64；Node v22.23.2；npm 10.9.8，實際比較一致 |
| 隔離 | target 原始 libseccomp filter 確實載入；AF_UNIX bind/listen/connect/data/socketpair 可用；AF_INET、AF_INET6、AF_PACKET 的 socket/socketpair 均為 EPERM；exec 子程序繼承拒絕 |
| 各次 offline | preflight、security tests、probe、post-scan 共 4 份隔離記錄，均完成原始 filter 檢查 |
| Registry/install | 無交易憑證、fresh HOME、分離空 npm configs；root npm ci 只作工具準備，既有 dependency graph 未修改；canary lock/tarball 各自新目錄安裝 |
| 既有 canary suites | boundary、source-policy、manifest-strict、artifact-content：122 tests，122 succeeded，0 failed，0 skipped |
| Canary audit | 本輪 registry 查詢 exit 0；high 0、critical 0、total 0；查詢時間 17:34:16.171–17:34:16.566 UTC |
| Probe | exit 0；forbiddenLoaded、unexpectedNetwork、moduleGraphHits 為空；liveExchangeWrite=false、productionCredentialUsed=false |
| 不可用 venue | `nado` exit 1，保留 `CANARY_VENUE_UNAVAILABLE:nado`，沒有靜默轉成 extended |
| 必要邊界掃描 | 前、後各 exit 0；禁止 packages/source/load 項目無命中 |

底層 probe 自己的 JSON 仍標為 userspace instrumentation；實際 Linux 保證來自包住該程序的 [probe-isolation.json](linux-artifact/scoped/offline/probe-isolation.json)，不是把 userspace 結果改名為 seccomp。Probe 在空 HOME 出現 `HALT_FAILED / RISK_STATE_*_MISSING`，屬安全停止觀察；`[extended] connected` 不證明交易所連線或策略正常交易。原始 commands、stdout、stderr、時間、exit 與 SHA 位於 `linux-artifact/scoped/logs/`；pack/install/audit/probe 的巢狀 subprocess 記錄位於 `nested/`。

## Artifact 與重新下載

GitHub artifact ID：`10068650245`。原始 [download 1](artifact-download-1.zip) 和 [download 2](artifact-download-2.zip) 各 385080 bytes；兩次獨立下載完全一致，且都符合 GitHub 的 archive digest：

`0d33a8332431c92a91d04c47c859fe9ead37e83091e92b97c3db56eda7dd73ad`

解壓後 bundle 與 scoped 層共 **465 筆 checksum** 全部一致；筆數包含外層重新涵蓋的內層檔案，不是 465 個互不重複的檔案。詳見 [下載與核對紀錄](download-verification.json)、[GitHub artifact metadata](artifacts.json)、[bundle SHA256SUMS](linux-artifact/SHA256SUMS)、[scoped manifest](linux-artifact/scoped/artifact-manifest.json)。

| 內容 | SHA-256 |
| --- | --- |
| Canary tgz（本輪兩次 pack 相同） | `e1065cf703ea2f738774b6761c27fb7d227d11863c6ea46be47df3d9fa2822f5` |
| content-manifest.json | `2510544ff839caa5ae82e972ffc2d583a864112eb0e6b86fa1d0a983461d1e84` |
| canary package-lock | `f66f1a14e91ca293d499b74420b1c669c9b11d0806cf87830d3ca59e64763f99` |

[完整 GitHub job raw log](github-job-log.zip) 另存 ZIP，並提供 [可逆 JSON 版本](github-job-log.json)。第二次 pack 的相同 SHA 是本輪工具記錄；第二份暫存 tgz 沒有封存，下載後獨立 byte 核對涵蓋封存的第一份。暫存 npm cache、HOME、node_modules 不作為交付 artifact；原始記錄中的絕對路徑屬於該次 runner。

## 已解除、仍阻塞、未執行

**已解除：** driver 提前終止漏收證據、忽略必要掃描結果、pins 寫死、未比較的 target/tool/publication 欄位，以及舊輸出與缺輸入偽成功。本次 scoped Linux 環境缺口已有實際 CI 證據補齊。

**仍阻塞：** 本機 Darwin 原生 Linux 驗證；root dependency/security clearance。Canary 的 0/0 audit 不適用 root graph。自動觸發的 [root CI](https://github.com/danny0971haha/classic-grid/actions/runs/34257856432) 另行記錄於 `root-ci-observation.json`，沒有拿它代替 scoped 結果，也沒有修改 baseline、dependency graph 或既有 required checks 讓整體變綠。

**獨立交接：** 本機 R2-A `d3129075d5866d27c79c6d2cba3b4b1128923889` 仍未發布；remote R2-A 維持 `39bf3a797b58f7fd91babf9f2d608cfd28e04487`，不是本次 target。

**未執行：** 全 root 驗證 wrapper 重跑、既有混合 registry/live canary test 的原命令重跑（本次依要求分離準備及 offline 步驟）、獨立接受、Route B 發布政策採用、R2-B、SDK 上游調查/重建、merge、rebase、force-push、frozen ref 移動、repository settings 更改、交易憑證使用、testnet/mainnet 寫入與部署。

## 封存格式檢查

程式 commit 的 `git diff --check` 為 0。Evidence-only diff 的格式檢查為 2：原始 `offline/unavailable-venue.txt` 與 `registry/canary-audit.json` 各包含結尾空白行；為維持 GitHub artifact 原始 bytes、既有 manifest 與 SHA256SUMS，未修剪或改寫這兩份原始輸出。沒有修改 whitespace gate 或其他治理規則。詳見 `evidence-whitespace-check.json`。
