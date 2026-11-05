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
#      git log --all -p 取不到 / grep 自身失败。**2 不是通过**——缺表时装绿比红危险。
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

# 一次性dump 全历史 patch，再逐串 grep：与"每条串各跑一次 git log --all -p | grep"
# 完全同内容同计数（grep -c 数的是行），只是把 13MB 的 git 输出从 N 次降成 1 次。
PATCH=$(mktemp "${TMPDIR:-/tmp}/history-sensitive-scan.XXXXXX") || exit 2
trap 'rm -f "$PATCH"' EXIT INT TERM
if ! git -C "$REPO" log --all -p >"$PATCH"; then
  echo "git log --all -p 失败（取不到全历史即扫不了，不是干净）" >&2
  exit 2
fi
PATCH_BYTES=$(wc -c <"$PATCH" | tr -d ' ')
ALL_COMMITS=$(git -C "$REPO" rev-list --count --all 2>/dev/null | tr -d ' ')
echo "扫描面：git log --all -p = ${PATCH_BYTES} 字节 / ${ALL_COMMITS} 个 commit（全 ref）"
echo "表：$TABLE"
echo "----"

index=0
malformed=0
hit_entries=0
hit_lines=0

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

  if [ "$count" -gt 0 ]; then
    hit_entries=$((hit_entries + 1))
    hit_lines=$((hit_lines + count))
    echo "HIT  第 $index 条 [$mode] $shown → $count 行"
  else
    echo "ok   第 $index 条 [$mode] $shown → 0 行"
  fi
done <"$TABLE"

echo "----"
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
echo "结论：绿——表内每一条在全历史里零命中"
exit 0
