# Command Output Round 4 真实模型回放证据

## 基本信息

- 日期：2026-06-20
- 模型：`deepseek-v4-flash`
- Provider：remote
- Fixture：14 个匿名化 tsc diagnostics，1182 字符
- 命令：`npx tsc --noEmit`
- Exit code：2
- 模式：`model_first`
- 回放次数：3

本文件只保存脱敏汇总，不保存完整模型响应。

## 结果

| Run | Response status | Analysis status | Findings | Evidence | Model calls | Fallback | Duration |
|---:|---|---|---:|---|---:|---|---:|
| 1 | valid | complete | 14/14 | 14 verified | 1 | false | 18142 ms |
| 2 | valid | complete | 14/14 | 14 verified | 1 | false | 15163 ms |
| 3 | valid | complete | 14/14 | 14 verified | 1 | false | 15907 ms |

平均耗时 16404 ms，总耗时 49212 ms。

## 门禁结果

- [x] 每次精确保留 14 个 findings。
- [x] 每次只有 1 次模型调用。
- [x] 每次均未使用 fallback。
- [x] response status 均为 valid。
- [x] analysis status 均不是 incomplete。
- [x] 非零退出的 summary 均未表达为 0 errors 或 no actionable findings。

实际 summary 分别为：

1. `14 TypeScript compilation errors across 4 files, primarily type assignability, missing properties, and unresolved names.`
2. `TypeScript compilation failed with 14 errors across 4 files.`
3. `14 TypeScript errors found in 4 files. Errors include type mismatches, missing names, and property access issues.`

回放脚本退出码：0。
