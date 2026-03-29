#!/bin/bash
# Test performance profiler — shows slowest test suites and individual tests
# Usage: ./scripts/test-perf.sh [threshold_ms]
#
# Runs bun test with JUnit output, parses timing data, and reports:
# 1. Slowest test suites (file-level)
# 2. Slowest individual tests above threshold (default: 200ms)

THRESHOLD_MS="${1:-200}"
OUTFILE="/tmp/test-results-perf.xml"

echo "Running tests with JUnit reporter..."
bun test --reporter=junit --reporter-outfile="$OUTFILE" 2>&1 | tail -3

echo ""
echo "=== Slowest test suites (top 15) ==="
grep -oP 'testsuite name="[^"]*" .*?time="[^"]*"' "$OUTFILE" \
  | sed 's/testsuite name="//;s/" .*time="/\t/;s/"//' \
  | awk -F'\t' '{printf "%7.1fms  %s\n", $2*1000, $1}' \
  | sort -rn | head -15

echo ""
echo "=== Individual tests > ${THRESHOLD_MS}ms ==="
grep -oP 'testcase name="[^"]*".*?time="[^"]*"' "$OUTFILE" \
  | sed 's/testcase name="//;s/".*time="/\t/;s/"//' \
  | awk -F'\t' -v threshold="$THRESHOLD_MS" '{ms=$2*1000; if(ms > threshold) printf "%7.1fms  %s\n", ms, $1}' \
  | sort -rn | head -30

echo ""
echo "=== Time distribution ==="
grep -oP 'testcase .*?time="[^"]*"' "$OUTFILE" \
  | grep -oP 'time="[^"]*"' \
  | sed 's/time="//;s/"//' \
  | awk '{
      ms=$1*1000;
      if(ms < 10) b["  <10ms"]++;
      else if(ms < 50) b[" <50ms"]++;
      else if(ms < 100) b["<100ms"]++;
      else if(ms < 500) b["<500ms"]++;
      else if(ms < 1000) b["  <1s"]++;
      else b["  >1s"]++;
      total++
    }
    END {
      for(k in b) printf "%7s: %4d tests (%5.1f%%)\n", k, b[k], b[k]/total*100
    }' | sort
