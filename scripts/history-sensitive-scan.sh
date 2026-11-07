#!/bin/sh
# 历史敏感串逐串扫描（G1b）——波次 2 的 exhaustive 兜底，owner 侧运行。
#
# 为什么需要它：形态守卫（packages/agent/history-hygiene.test.ts）只认**形态**，
# 覆盖不到"长得不像任何形态"的敏感串（客户名、真实读数、事故附件名），也覆盖不到
# 不带前缀的 UserID 裸常量（实测带前缀只占 4/22 行）。逐串扫描按表里的**字面/正则**
# 一条条数，是唯一能把"表内每一条都归零"钉死的判据。两者缺一不可。
#
# 用法：scripts/history-sensitive-scan.sh <敏感串表>
#   表 = filter-repo --replace-text 格式（每行 old==>new，或以 regex: 开头的正则行）。
#   LHS（==> 左侧 / regex: 右侧的正则体）就是被扫描的串；RHS 只是替换值，不参与扫描。
#
# 退出码（写死，别改语义）：
#   0  表内每一条都零命中
#   1  有命中（重写没清干净 / 新 commit 又带回来）
#   2  扫不了：无参 / 多参 / 表文件缺失或为空 / 表内行无法解析 / 表内无有效条目 /
#      git log --all -p 取不到 / git ls-files 取不到 / 豁免清单缺失或含不可解析行 /
#      grep 自身失败 / 命中行归位（awk）失败。**2 不是通过**——缺表时装绿比红危险。
#
# ── 同口径豁免（D-191：与门①档案豁免同半径；owner 2026-11-06 裁定门①「只产品面
#    零引用」、2026-11-07 落地裁定选 (A) 登记改造 commit 清单）──
# 口径（窄、可机械复述；清单 = scripts/history-scan-exemptions.txt，提交进仓，
# 清单改必同步 docs/debt-ledger.md D-191）：
#   扫描面不变，仍是 git log --all -p 全历史。命中行先归位：diff 头之外的行
#   （commit message 行）归「当前 commit」；diff 行按 diff 头归文件（`-` 行归
#   a/ 侧路径，其余行归 b/ 侧路径）。然后按三类豁免：
#     (1) 清单 archive 行登记的档案路径（与门①档案豁免同半径）——该文件全部
#         diff 行豁免（现有内容 + 删除行改造史）；
#     (2) 已不在当前树（git ls-files）里的文件——全部 diff 行豁免（已移除误提交
#         文件的残影；机械判定，不在清单里写文件名）；
#     (3) 清单 commit 行登记的改造 commit——该 commit 的 diff 行与 message 行
#         豁免（脱敏/中性化/表征冻结工作在测试文件与消息体里的自述留存）。
# 安全底线：**新 commit 永不在清单内**——清单是冻结的历史登记，新增 commit 一律
#   照算。未来任何新引入的真实敏感数据（客户名/读数/UserID/路径），哪怕只出现在
#   消息体里，也照样红。真实敏感数据不在本豁免口径内，为它们开洞就是拆防线；
#   本豁免只覆盖平台实例名在档案、改造史与已移除文件里的留存。
# why（第 15 条平台实例名实测 12 行，分布五处，D-191 销账记录如实登记）：
#   debt-ledger 档案 5 行（门①同半径）、已移除文件 pp-waves-c.json 2 行（残影）、
#   中性化 commit 删除 diff 2 行、W1 表征 commit 新增脱敏自述注释 1 行、脱敏期
#   commit message 2 行——后三处是改造史留存，由 (3) 覆盖。其余 33 条（真实敏感
#   数据）全历史零命中，与本豁免无关。
# 兜底（宁可红不可假绿）：
#   清单文件缺失或含不可解析行 = 口径不完整 = exit 2 扫不了；diff 头带引号（git
#   对非 ASCII/特殊路径做 octal 转义）或解析不出 a/ b/ 两侧路径时，该文件的行一律
#   照算不豁免；git ls-files / awk 失败按 exit 2「扫不了」处理。豁免行数在输出里
#   单列，豁免不得无声。
#
# 为什么不接进 npm test：表文件本身含全部敏感串原文，是 gitignored 的本地文件。
# 接进 CI 要么得把表提交进库（泄密），要么表缺失时整条跳过（真空绿）。两样都不接受，
# 于是它刻意留在 CI 之外，由 owner 在实做前后各跑一次。
#
# 输出纪律：默认**不打印串本身**，只打条目序号 + LHS 的 sha256 前 12 位 + 命中行数
# （命中文本进日志 = 把敏感串再抄一遍进 CI 日志）。要核对具体某一条时加
# HISTORY_SCAN_SHOW_LITERALS=1 本地跑，输出别外发。
set -u

usage() {
  cat >&2 <<'EOF'
用法：scripts/history-sensitive-scan.sh <敏感串表>

  表文件：filter-repo --replace-text 格式（old==>new；或以 regex: 开头的正则行）。
          本仓的交付形态是 gitignored 的 .sensitive-strings.replace.txt。
  退出码：0 = 每条零命中；1 = 有命中；2 = 扫不了（缺表/空表/行不可解析/git 失败）。
          2 不得当成通过。
EOF
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

TABLE=$1
if [ ! -f "$TABLE" ]; then
  echo "表文件不存在：$TABLE" >&2
  echo "（表是 gitignored 本地文件，缺失即无法扫描——这是退出码 2，不是通过）" >&2
  exit 2
fi
if [ ! -s "$TABLE" ]; then
  echo "表文件为空：$TABLE（无有效条目即无法扫描）" >&2
  exit 2
fi

REPO=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO" ]; then
  echo "取不到仓库根目录（git rev-parse --show-toplevel 失败）" >&2
  exit 2
fi

# ── 加载豁免清单 scripts/history-scan-exemptions.txt ──
# 格式：archive <path> / commit <40 位 SHA> / entry <sha256 前 12 位> / 空行 / # 开头注释。
EXEMPT_FILE="$REPO/scripts/history-scan-exemptions.txt"
if [ ! -f "$EXEMPT_FILE" ]; then
  echo "豁免清单不存在：$EXEMPT_FILE（口径不完整，无法扫描）" >&2
  exit 2
fi
if [ ! -s "$EXEMPT_FILE" ]; then
  echo "豁免清单为空：$EXEMPT_FILE（口径不完整，无法扫描）" >&2
  exit 2
fi

# 用 awk 预解析豁免清单，分别输出到三个临时文件：
#   ARCHIVE_TMP：archive 路径列表（每行一个，重复自动去重）
#   COMMIT_TMP：commit SHA 列表（每行一个，重复自动去重）
#   ENTRY_TMP：entry  sha256 前 12 位列表（每行一个，重复自动去重）
ARCHIVE_TMP=$(mktemp "${TMPDIR:-/tmp}/history-scan-arch.XXXXXX") || exit 2
COMMIT_TMP=$(mktemp "${TMPDIR:-/tmp}/history-scan-commit.XXXXXX") || exit 2
ENTRY_TMP=$(mktemp "${TMPDIR:-/tmp}/history-scan-entry.XXXXXX") || exit 2
awk '
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  /^archive[[:space:]]+/ { sub(/^archive[[:space:]]+/, ""); print > "'"$ARCHIVE_TMP"'"; next }
  /^commit[[:space:]]+/ { sub(/^commit[[:space:]]+/, ""); print >> "'"$COMMIT_TMP"'"; next }
  /^entry[[:space:]]+/ { sub(/^entry[[:space:]]+/, ""); print >> "'"$ENTRY_TMP"'"; next }
  { print "豁免清单不可解析行（第 " NR " 行）：[" $0 "]" > "/dev/stderr"; exit 2 }
' "$EXEMPT_FILE" || {
  echo "豁免清单含不可解析行——先修清单再谈命中（退出码 2，不是通过）" >&2
  rm -f "$ARCHIVE_TMP" "$COMMIT_TMP" "$ENTRY_TMP"
  exit 2
}

# 从解析结果读取 archive / commit / entry 集合
ARCHIVE_SET=""
while IFS= read -r a_path; do
  [ -z "$a_path" ] && continue
  if [ -z "$ARCHIVE_SET" ]; then
    ARCHIVE_SET="$a_path"
  else
    ARCHIVE_SET="$ARCHIVE_SET
$a_path"
  fi
done < "$ARCHIVE_TMP"

COMMIT_SET=""
while IFS= read -r c_sha; do
  [ -z "$c_sha" ] && continue
  if [ -z "$COMMIT_SET" ]; then
    COMMIT_SET="$c_sha"
  else
    COMMIT_SET="$COMMIT_SET
$c_sha"
  fi
done < "$COMMIT_TMP"

ENTRY_SET=""
while IFS= read -r e_prefix; do
  [ -z "$e_prefix" ] && continue
  if [ -z "$ENTRY_SET" ]; then
    ENTRY_SET="$e_prefix"
  else
    ENTRY_SET="$ENTRY_SET
$e_prefix"
  fi
done < "$ENTRY_TMP"

# 一次性dump 全历史 patch，再逐串 grep：与"每条串各跑一次 git log --all -p | grep"
# 完全同内容同计数（grep -c 数的是行），只是把 13MB 的 git 输出从 N 次降成 1 次。
PATCH=$(mktemp "${TMPDIR:-/tmp}/history-sensitive-scan.XXXXXX") || exit 2
TREE=$(mktemp "${TMPDIR:-/tmp}/history-scan-tree.XXXXXX") || exit 2
HITLINES=$(mktemp "${TMPDIR:-/tmp}/history-scan-lines.XXXXXX") || exit 2
trap 'rm -f "$PATCH" "$TREE" "$HITLINES"' EXIT INT TERM
if ! git -C "$REPO" log --all -p >"$PATCH"; then
  echo "git log --all -p 失败（取不到全历史即扫不了，不是干净）" >&2
  exit 2
fi
# 树清单：同口径豁免第 (2) 类（已移除文件）的机械判据。失败 = 归不了口径 = 扫不了。
if ! git -C "$REPO" ls-files >"$TREE"; then
  echo "git ls-files 失败（取不到当前树清单即无法归口径，不是干净）" >&2
  exit 2
fi
PATCH_BYTES=$(wc -c <"$PATCH" | tr -d ' ')
ALL_COMMITS=$(git -C "$REPO" rev-list --count --all 2>/dev/null | tr -d ' ')
echo "扫描面：git log --all -p = ${PATCH_BYTES} 字节 / ${ALL_COMMITS} 个 commit（全 ref）"
echo "表：$TABLE"
echo "豁免清单：$EXEMPT_FILE（档案 $(echo "$ARCHIVE_SET" | grep -c '.' || echo 0) 个路径 / 改造 commit $(echo "$COMMIT_SET" | grep -c '.' || echo 0) 个）"
echo "----"

index=0
malformed=0
hit_entries=0
hit_lines=0
total_ex_commit=0
total_ex_arch=0
total_ex_removed=0

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'*) continue ;;
  esac
  index=$((index + 1))

  case "$line" in
    regex:*)
      body=${line#regex:}
      case "$body" in
        *"==>"*) lhs=${body%%"==>"*} ;;
        *)
          malformed=$((malformed + 1))
          echo "第 $index 行：regex: 行缺少 ==> 分隔，无法取正则体" >&2
          continue
          ;;
      esac
      mode=regex
      ;;
    *"==>"*)
      lhs=${line%%"==>"*}
      mode=literal
      ;;
    *)
      malformed=$((malformed + 1))
      echo "第 $index 行：既不含 ==> 也不以 regex: 开头，无法解析" >&2
      continue
      ;;
  esac

  if [ -z "$lhs" ]; then
    malformed=$((malformed + 1))
    echo "第 $index 行：LHS 为空" >&2
    continue
  fi

  if [ "$mode" = regex ]; then
    count=$(grep -c -E -- "$lhs" "$PATCH" 2>/dev/null)
    grep_status=$?
  else
    count=$(grep -c -F -- "$lhs" "$PATCH" 2>/dev/null)
    grep_status=$?
  fi
  if [ "$grep_status" -gt 1 ]; then
    echo "第 $index 行：grep 自身失败（状态 $grep_status）——${mode} 模式，扫不了" >&2
    exit 2
  fi
  case "$count" in
    '' | *[!0-9]*)
      echo "第 $index 行：取不到计数（grep 输出异常）" >&2
      exit 2
      ;;
  esac

  digest=$(printf '%s' "$lhs" | sha256sum 2>/dev/null | cut -c1-12)
  shown=$digest
  if [ "${HISTORY_SCAN_SHOW_LITERALS:-0}" = "1" ]; then
    shown="$lhs"
  fi

  # 预计算当前条目的 sha256 前缀，检查是否在 entry 集合里
  # （只对明确登记的平台实例名条目应用 archive / commit 豁免）
  entry_match=0
  if [ -n "$ENTRY_SET" ]; then
    lhs_prefix=$(printf '%s' "$lhs" | sha256sum 2>/dev/null | cut -c1-12)
    while IFS= read -r e_prefix; do
      if [ "$e_prefix" = "$lhs_prefix" ]; then
        entry_match=1
        break
      fi
    done <<< "$ENTRY_SET"
  fi

  # ── 同口径豁免：命中行按 diff 头归文件，三类豁免 ──
  # 口径与 why 见文件头注释。net = 豁免后仍照算的行数；只有 net 计入命中。
  # 归不了文件（message 行，但当前 commit 不在豁免清单）照算不豁免。
  net=$count
  ex_commit=0
  ex_arch=0
  ex_removed=0
  if [ "$count" -gt 0 ]; then
    if [ "$mode" = regex ]; then
      grep -n -E -- "$lhs" "$PATCH" >"$HITLINES"
    else
      grep -n -F -- "$lhs" "$PATCH" >"$HITLINES"
    fi
    grep_status=$?
    if [ "$grep_status" -gt 1 ]; then
      echo "第 $index 条：命中行定位 grep 失败（状态 $grep_status）——扫不了" >&2
      exit 2
    fi
    raw_lines=$(wc -l <"$HITLINES" | tr -d ' ')
    if [ "$raw_lines" != "$count" ]; then
      echo "第 $index 条：两遍 grep 计数不一致（$count vs $raw_lines）——扫不了" >&2
      exit 2
    fi

    # 将豁免清单写入 awk 可以读取的临时文件
    ARCHIVE_TMP=$(mktemp "${TMPDIR:-/tmp}/history-scan-arch.XXXXXX") || exit 2
    COMMIT_TMP=$(mktemp "${TMPDIR:-/tmp}/history-scan-commit.XXXXXX") || exit 2
    printf '%s\n' "$ARCHIVE_SET" > "$ARCHIVE_TMP"
    printf '%s\n' "$COMMIT_SET" > "$COMMIT_TMP"

    exout=$(awk -v linefile="$HITLINES" -v treefile="$TREE" \
      -v archfile="$ARCHIVE_TMP" -v commitfile="$COMMIT_TMP" \
      -v entry_match="$entry_match" '
      BEGIN {
        while ((getline t < treefile) > 0) tree[t] = 1
        close(treefile)
        while ((getline n < linefile) > 0) want[n + 0] = 1
        close(linefile)
        while ((getline a < archfile) > 0) { gsub(/[[:space:]]*$/, "", a); if (a != "") archive[a] = 1 }
        close(archfile)
        while ((getline c < commitfile) > 0) { gsub(/[[:space:]]*$/, "", c); if (c != "") commit_exempt[c] = 1 }
        close(commitfile)
        indiff = 0; apath = "?"; bpath = "?"
        cur_commit = ""
        ec = 0; ea = 0; er = 0
      }
      function classify(pref) {
        # 只对明确登记的平台实例名条目应用 archive / commit 豁免；
        # 其余条目保留完整历史扫描（不拆防线）。
        if (entry_match != "1") { er++; return }
        if (cur_commit in commit_exempt) { ec++; return }
        if (!indiff || apath == "?") { er++; return }
        f = (pref == "-") ? apath : bpath
        if (f in archive) { ea++; return }
        if (f in tree) { er++; return }
        # 不在当前树里 = 已移除文件，豁免（第 2 类）
        erm++
      }
      /^commit [0-9a-f]{40}/ {
        cur_commit = $2
        indiff = 0; apath = "?"; bpath = "?"
        next
      }
      /^diff --git a\// {
        h = $0
        sub(/^diff --git a\//, "", h)
        p = index(h, " b/")
        if (p > 1 && index(h, "\"") == 0) {
          apath = substr(h, 1, p - 1)
          bpath = substr(h, p + 3)
          indiff = 1
        } else {
          apath = "?"; bpath = "?"; indiff = 0
        }
        if (FNR in want) classify(substr($0, 1, 1))
        next
      }
      /^diff / {
        indiff = 0; apath = "?"; bpath = "?"
        if (FNR in want) classify(substr($0, 1, 1))
        next
      }
      { if (FNR in want) classify(substr($0, 1, 1)) }
      END {
        # ec = commit-exempt (covers both diff + message lines for exempt commit)
        # ea = archive-exempt (diff lines for archive files)
        # erm = exempt-removed (diff lines for files not in current tree)
        # er = real (in-tree non-archive or message lines for non-exempt commit)
        printf "%d %d %d %d\n", ec, ea, erm, er
      }
    ' "$PATCH") || {
      echo "第 $index 条：命中行归文件失败（awk）——扫不了，不是通过" >&2
      rm -f "$ARCHIVE_TMP" "$COMMIT_TMP"
      exit 2
    }
    rm -f "$ARCHIVE_TMP" "$COMMIT_TMP"

    ex_commit=${exout%% *}
    _rest=${exout#* }
    ex_arch=${_rest%% *}
    _rest2=${_rest#* }
    ex_removed=${_rest2%% *}
    net=${_rest2##* }
    case "${ex_commit}${ex_arch}${net}" in
      '' | *[!0-9]*)
        echo "第 $index 条：归口径输出异常（$exout）——扫不了" >&2
        exit 2
        ;;
    esac
    if [ $((ex_commit + ex_arch + ex_removed + net)) -ne "$count" ]; then
      echo "第 $index 条：豁免归账不一致（$ex_commit + $ex_arch + $ex_removed + $net != $count）——扫不了" >&2
      exit 2
    fi
    total_ex_commit=$((total_ex_commit + ex_commit))
    total_ex_arch=$((total_ex_arch + ex_arch))
    total_ex_removed=$((total_ex_removed + ex_removed))
  fi

  if [ "$net" -gt 0 ]; then
    hit_entries=$((hit_entries + 1))
    hit_lines=$((hit_lines + net))
    if [ "$net" -eq "$count" ]; then
      echo "HIT  第 $index 条 [$mode] $shown → $net 行"
    else
      echo "HIT  第 $index 条 [$mode] $shown → $net 行（原始 $count 行，豁免 $((ex_commit + ex_arch + ex_removed)) 行：改造commit $ex_commit / 档案 $ex_arch / 已移除文件 $ex_removed）"
    fi
  elif [ "$count" -gt 0 ]; then
    echo "ok   第 $index 条 [$mode] $shown → 0 行（原始 $count 行全部落在同口径豁免面：改造commit $ex_commit / 档案 $ex_arch / 已移除文件 $ex_removed）"
  else
    echo "ok   第 $index 条 [$mode] $shown → 0 行"
  fi
done <"$TABLE"

echo "----"
total_ex=$((total_ex_commit + total_ex_arch + total_ex_removed))
echo "同口径豁免：合计 ${total_ex} 行（改造commit $total_ex_commit / 档案 $total_ex_arch / 已移除文件 $total_ex_removed）——口径见脚本头注释"
echo "条目 $index 条；命中 $hit_entries 条 / 合计 $hit_lines 行；不可解析 $malformed 行"

if [ "$malformed" -gt 0 ]; then
  echo "表内有 $malformed 行无法解析——先修表再谈命中（退出码 2，不是通过）" >&2
  exit 2
fi
if [ "$index" -eq 0 ]; then
  echo "表里没有有效条目（全是空行/注释）——无扫描对象即无法判定" >&2
  exit 2
fi
if [ "$hit_entries" -gt 0 ]; then
  echo "结论：红——$hit_entries 条在历史里仍有命中（合计 $hit_lines 行）" >&2
  exit 1
fi
echo "结论：绿——表内每一条在全历史里零命中（档案/改造commit/已移除文件同口径豁免后）"
exit 0
