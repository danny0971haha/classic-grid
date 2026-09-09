# Classic Grid：PR15 工程結案核對與固定 target 的 Route B 資格材料

日期：2026-09-09。唯一 repository：`danny0971haha/classic-grid`。

本輪結論：PR15 A/B 已有充分工程結案證據；既有固定 tool＋target 的 scoped 材料足供 owner 與正式獨立審查者作限定資格決定。`NO_NEW_CODE_CHANGE_REQUIRED`。沒有新程式修正、重跑 CI、更新測試候選 HEAD 或採用 Route B。整體 CI 仍是 failure；root dependency audit 阻塞保留。

這是實作協作自查與證據對帳，沒有作出 ACCEPT、MERGE AUTHORIZED 或 LIVE AUTHORIZED 判定。報告／ZIP 另以 evidence-only branch 發布；其 publication commit 只是資料交付身分，不是新增被測產物，不移動 PR13/14/15、target 或 frozen refs。

## 0. 身分與閱讀對帳

已讀 PR15 工作樹實際存在的 AGENTS.md、AI_START_HERE.md、CURRENT_STATUS、IMPLEMENTATION_EVIDENCE、SECURITY、repository protection、security audit baseline、相關 E/F 與 canary verification 工具／契約、PR13 decision record、PR14 driver/workflow、PR15 差異與既有 REPORT/原始交付。主工作樹沒有 AGENTS.md，未假裝其存在；適用入口由實際 PR15/target 工作樹取得。先以既有報告定位，再以當前 Git objects、GitHub API、原始 logs 與新下載封包覆核。

| 身分 | HEAD | Tree／base |
| --- | --- | --- |
| PR15 engineering delivery | `ff3d896c427c3d0ca2833879655157029040e044` | tree `fb693000a7ea157b0995ee9b58592c53ce072419` |
| PR15 branch/base | `fix/classic-ci-inventory-evidence-20260909` | `fix/classic-canary-driver-20260909` @ `40223bb5e106668e2d5a2c8971579b41e7a9dbfa` |
| PR14／scoped tool | `40223bb5e106668e2d5a2c8971579b41e7a9dbfa` | tree `c99180aab2b4cf9b4abb40780c7d2192686d9eec`；base 固定 target |
| 固定 target | `fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf` | tree `7f14f66eac518c4427076f18fbcfdc7d935c79d8` |
| PR13 decision record | `e420b317dc7f7166f70d24701763c0ab15364c68` | tree `46537b843ea6a251b34ee979b34d024e2b95980f` |
| Frozen R1 | `990a790706e17b52e04d0d1957505cdad5d45862` | tree `c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8` |
| Remote R2-A | `39bf3a797b58f7fd91babf9f2d608cfd28e04487` | tree `fb139e4737711602df44636e8186ccc6694de654` |
| 主工作樹既有本機快照 | `d3129075d5866d27c79c6d2cba3b4b1128923889` | tree `ce5de3b01e3506d5e3a7672958696a7acadfce1c`；比 remote R2-A 多 3 commits，保留 |

指定 remote refs、PR head/base 與 local Git trees 一致，未發現指定身分漂移。主工作樹是已存在的不同快照，不拿來替代 PR15 或固定 target；沒有 reset、覆寫、rebase 或 force-push。詳見 ZIP 的 `checks/object-identities.json`、`ref-reconciliation.json`、原始 before/final refs 與 worktree observations。對原始證據的判斷不延伸至未來 ref 變動。

## 1. PR15 A/B 工程結案結果

**A：清冊測試已對齊，政策未放寬。** 兩個正式 repository inventory 測試均逐項 `deepEqual` 檢查 exact tracked manifests、scanned files，以及七次 file/identity/full-SHA tuple：

| Workflow | Action | Full SHA | 次數 |
| --- | --- | --- | ---: |
| `.github/workflows/ci.yml` | checkout | `11d5960a326750d5838078e36cf38b85af677262` | 1 |
| `.github/workflows/ci.yml` | setup-node | `49933ea5288caeca8642d1e84afbd3f7d6820020` | 1 |
| `.github/workflows/ci.yml` | upload-artifact | `ea165f8d65b6e75b540449e92b4886f43607fa02` | 4 |
| `.github/workflows/classic-canary-scoped.yml` | upload-artifact | 同上完整 SHA | 1 |

既有反例把真實 scoped upload 改為 `v4` 或 `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`，分別仍遭 immutable-pin／allowlist 政策拒絕。已下載 security checker 原始 TAP 確認反例執行成功；既有 Docker、symlink、YAML/local/reusable workflow 等反例保留。PR14→PR15 diff 限兩個測試檔與歷史證據封装；workflow、scanner、Action allowlist、audit policy/baseline、runtime、vendor、package.json、全部 lockfile 和独立 Linux evidence 皆未改。

**B：47-file archive 無損保留可核對。** 現有 `verify_archive.py` 驗證／還原機制及既有 restore 成果已對原 Git source `40223bb…` 比對：47 檔、313,383 bytes、原路径、100644／0644 modes、Git blobs、SHA-256、原 45-entry manifest 皆保留。原 manifest 自身與 `identity-after-packet.txt` 由外層47項清單覆蓋。歷史 archive SHA-256：`aa60ca2154db0d0b49f14c2093932049be70255624b65d72f77262cb2cae7c38`。沒有 trim／重序列化歷史 logs 或重新封裝歷史資料。既有 traversal、absolute、duplicate、corruption、symlink、wrong-mode、missing-file 與 existing-destination 拒絕證據保留。

**CI 實際身分與結論：** [run 34315427266 attempt 1](https://github.com/danny0971haha/classic-grid/actions/runs/34315427266/attempts/1)，job `102350517851`。GitHub 測試 merge checkout `91cf2a5bd4382185236dc45b20cb5da60d117052` 的 tree 與 PR15 相同；兩個 commit 仍分開記錄。E/F source=`ff3d896…`、base=`40223bb…`，Node `v22.23.2`／npm `10.9.8`。

| 實際層級 | required_19 root audit | required_20 offline replay |
| --- | --- | --- |
| Shell exit | 1，raw runner log 明載 | 1，raw runner log 明載 |
| `steps.<id>.outcome` | failure | failure |
| continue-on-error 後 conclusion | success | success |
| 最終 aggregator | exit 1，列出兩個 failure | 同左 |
| Job／workflow | failure／failure | 同左 |

32 required outcomes 中30 success、2 failure。一般成功 shell 的0由原 outcome 推得，沒有偽造逐命令列印的exit記錄；JavaScript Actions 的 shell exit 為 N/A。完整分層矩陣在 `checks/ci-step-matrix.json`，原始 `REQUIRED_RESULTS` 在 `checks/ci-original-outcomes.json`，未只讀 UI conclusion。

已下載 E/F、security inventory、dependency boundary 全部四包並比對 API ZIP digest。下載後使用既有 E/F verifier 核對，未靠上傳前目錄替代；E/F project suite 都是696/696、fail/skip=0，checkpoint suite各30/30及40/40。Security checker為227/227；inventory專項既有本機34/34。生成、驗證、上傳與 whitespace 的原始 outcomes 均成功。詳見 [A/B 核對附件](ab-review.md) 及 ZIP 的 `ab-checks/`。以上支持 A/B 工程結案，不把整體 CI 說成綠燈。

## 2. 固定 tool＋target 的 scoped 證據充分性

本輪重新下載 [run 34257856526 attempt 3](https://github.com/danny0971haha/classic-grid/actions/runs/34257856526/attempts/3)，job `102349201604`、artifact `10089752885`。tool與target完全沿用第0節固定組合。這不是 PR15 新HEAD的scoped coverage；PR15未被這份既有workflow觸發符合原base/head範圍，並非待修bug。

| 固定 canary 採用／審查身分 | SHA-256 |
| --- | --- |
| Attempt 3 artifact ZIP | `3b6fab4cd627471b2033ea8d23fc988fee919944b20d56103b68b5eeadb201f8` |
| 實際 retained `.tgz` | `00edfb9bf682b6e7e1047e832a58c30dacef2dc613720b8c10286a1e6f805ad5` |
| Embedded content manifest | `2510544ff839caa5ae82e972ffc2d583a864112eb0e6b86fa1d0a983461d1e84` |
| Canary package.json | `963b107843569df257e22f24bf55f9598c024b787f3e1601855fb791dc874e76` |
| Canary source file-manifest.json | `3d6c083d41e76489981733721fcc389aa5b1985dbd655ffc557acac40ee16690` |
| Canary package-lock.json | `f66f1a14e91ca293d499b74420b1c669c9b11d0806cf87830d3ca59e64763f99` |
| `src/cli/run-extended-canary.ts` | `3301e908c8558317794d66837842aa67c7993429b964fe105d38f91f4b3f6d16` |

下載後驗得249外層＋216內層＝465筆checksum（覆蓋有重疊，不是465個獨立檔案）、215筆scoped artifact manifest、38筆命令stdout/stderr metadata；全部吻合。Tgz有44 members＝36 regular files＋8 directories，35份manifest payload源檔的bytes/mode與固定target Git一致，另1份生成content manifest。精確tar成員、installed metadata遍歷、locked版本與192筆resolved module graph共同支持隔離界線，並非字串搜尋未命中。

Canary entrypoint 注入 Extended-only executor／unavailable official-statistics bindings，與root `src/cli/run.ts` 分離；禁止root toml、nord-ts、其他venue SDK與被排除源檔未進入指定artifact、當時installed inventory或實際loaded graph。安裝包為 `@esbuild/linux-x64@0.28.2`、`esbuild@0.28.2`、`tsx@4.23.12`、`undici@6.28.0`、`ws@8.21.3`。Module graph＝95 canary install paths＋96 Node builtins＋1明列verifier bootstrap；未解析到其他root依賴。

Registry/bootstrap與離線驗證分相。四份Linux核心隔離報告分別覆蓋preflight、tests、probe、post-scan，實測AF_UNIX可用，AF_INET/INET6/PACKET/socketpair遭EPERM，exec子程序繼承阻斷。Node archive pin及实际Node/npm版本吻合。25個driver regressions與122個canary tests均保留；非Extended `nado` exit1、缺隔離／錯身分／缺graph等fail-closed反例有效。Canary registry audit於05:28:23–05:28:24 UTC捕捉exit0、high/critical/total均0；僅是該次canary graph的歷史觀察。

邊界限制已明載：node_modules實體樹未封存，依原始安裝命令與retained inventories交叉驗證；loaded graph只覆蓋實際dry-run `--once`路徑。Probe保留缺risk-state/ACK的安全停止，`[extended] connected`不是交易所連線證據。第二次tgz只留hash，且與第一份不同；原契約要求content manifest一致，不要求tar/gzip容器逐byte重現。本輪僅獨立驗證retained第一份tgz，不替未封存第二份補造證據。這些限制不构成本輪指定歷史資格材料缺少的必要驗證，不需重跑或改工具。

舊artifact `10068650245`／tgz `e1065cf…`屬較早執行，不能混入attempt3採用身分。詳見 [scoped核對附件](scoped-review.md) 與 `scoped-analysis.json`。

## 3. Root audit／offline replay 真實拒絕

Root audit實際捕捉時間`2026-09-09T05:40:07.355Z`，`npm audit --omit=dev --json` status1、signal/error均null。16 high／8 moderate／0 critical／24 total。既有High不是clearance；兩個新增TOML high仍為：

- `GHSA-82x6-q7mm-w9cf`
- `GHSA-v5mp-jgw5-2x6j`

Root diagnostic stdout、root audit.json與replay audit.json逐byte相同，SHA-256都是`c6f9fce7ec0e68c62954ee4f94a1d66a2cfbe3d19166b029fcba62fc091284c9`；兩份verification JSON亦逐byte一致、overallPolicyOk=false，原始各步exit1分別保留。`ADVISORY_SOURCE_RENUMBERED`（axios同GHSA數字source變更）與`AFFECTED_PACKAGE_ADDED`也照原結果保留，不混同NEW_HIGH。

Root lock SHA-256仍為`f278d8b7f0d559839e35ee64e94db9e39c7d6037f5692d0cafa02ba6c6b254ed`。本輪沒有新registry audit、沒有重新執行歷史root replay；下載後對帳已足夠。原workflow的replay以`--audit-json artifacts/security/audit.json --out-dir artifacts/security/replay`讀同一份captured bytes，既有工具在此分支不呼叫npm audit。其offline意指使用捕捉資料而不重新查registry；不拿它冒充scoped Linux seccomp證據。

## 4. Route A 缺少的外部輸入

沿用 [PR13固定decision record](https://github.com/danny0971haha/classic-grid/blob/e420b317dc7f7166f70d24701763c0ab15364c68/docs/evidence/dependency-prereq-20260908/classic-handoff.md)。本輪沒有收到新source/build/harness輸入，所以沒有重做SDK歷史調查；以下是該紀錄仍待提供的項目，不是宣稱本輪刷新了上游網站狀態。

| 缺項 | 提供者 |
| --- | --- |
| npm `@n1xyz/nord-ts@0.6.3`／任何擬議候選artifact到immutable source commit/tree的可驗證對映 | N1/nord-ts供應者或其指定可驗證來源 |
| 相同commit的parent engine proto／buf module | N1上游parent repository擁有者 |
| Nix `#openapi`、flake.lock及parent build inputs，或上游支持的standalone recipe | N1 build／release維護者 |
| 真正用來產生published dist的Bun/Nix/openapi-typescript/protoc-gen-es版本與hash | N1 release維護者 |
| 原parser harness、fixtures、qualification packet及列明缺失的原始報告 | 原調查／交付者；由Classic owner協調提供 |

`ROUTE_A=BLOCKED_MISSING_INPUTS`，candidate未建立。未修改package.json／任何lock／baseline／豁免／audit policy，未使用audit fix --force或toml override，未宣稱SDK內嵌parser已修復。

## 5. Owner 對 Route B 尚須決定的精確範圍

建議把第2節固定組合提交限定資格審查；**owner尚未採用Route B**。Owner需明文決定：是否可將獨立Extended-only artifact作為publication／qualification單位，並以第0、2節完整target HEAD/tree、entrypoint、package/lock/source/content manifests、retained tgz、tool HEAD/tree及run/attempt/artifact digest綁定該決定。

決定需明示root入口、root/global依賴圖、非Extended venue、local R2-A、PR15其他程式及未來target不在此限定資格範圍；root High保持可見與阻塞。不要靜默替換root npm start或修改workflow／audit gate。此輪只交資格材料及建議，正式獨立審查、owner採用、merge、部署及任何憑證／testnet／mainnet操作均為尚未發生的不同決定；後續產物變更須綁定新bytes，不能沿用舊run。

## 6. 新缺陷、修改、測試、CI

`NO_NEW_CODE_CHANGE_REQUIRED`。沒有找到可重現的inventory、archive verifier或既有canary驗證工具新缺陷；沒有corrective branch／Draft PR、沒有新增重複tests、沒有新HEAD CI或scoped rerun。

本輪執行的是Git/API身分及保護範圍差異比對、五個artifact新下載與digest／封包內容核對、existing archive/restore成果與Git比對、下載後E/F現有verifier核對、root captured bytes/replay結果比對、scoped manifests／payload／installed／loaded／kernel證據交叉檢查、交付秘密模式掃描及發佈後ZIP下載比對。原696／227／34／25／122等測試數字全屬明列原run或既有local證據，沒有冒充本輪新測試。

## 7. 自查與正式獨立審查

主代理整合核對，另依實際AGENTS的平行唯讀審查指示，由兩個協作子代理分別核對A/B及scoped證據。它們屬同一實作協作流程，不是正式獨立審查、PR approval或owner接受。本報告只主張所列固定bytes的證據充分性與工程結案核對結果。

沒有交易所憑證載入、交易所連線、testnet/mainnet write、merge、rebase、force-push、部署、治理設定變更或新交易階段。唯一遠端寫入為同repository的獨立證據發佈與使用者要求的PR comment索引。

## 8. ChatGPT 可讀交付與重驗索引

同目錄的`classic-grid-pr15-closeout-route-b-20260909.zip`包含本報告、A/B與scoped細節、五份原下載ZIP及展開副本、GitHub API原始回應／job logs、機器可讀對帳、必要immutable source references及既有歷史archive原bytes。`SHA256SUMS`核對交付檔，ZIP內`FILE_MANIFEST.json`綁定每檔bytes/路徑/mode；原始artifact內manifest不改寫。

[PR15](https://github.com/danny0971haha/classic-grid/pull/15)索引主報告、[PR14](https://github.com/danny0971haha/classic-grid/pull/14)索引固定tool/target材料、[PR13](https://github.com/danny0971haha/classic-grid/pull/13)索引owner待決範圍。Comments採固定publication commit連結及ZIP SHA-256；證據branch不建立PR、不觸發新候選CI、不移動上述PR heads。

去秘密範圍：只收集指定repository的公開CI/evidence/Git來源與本輪核對記錄，未收集HOME、環境檔或credential store；包含nested ZIP/tgz的有界credential-pattern與路徑/type掃描，不宣稱普遍無秘密證明。不改寫任何歷史原始bytes來取得掃描成功。
