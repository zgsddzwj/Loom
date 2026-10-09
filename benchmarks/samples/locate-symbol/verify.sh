#!/bin/bash
# PASS iff answer.txt names the definition site of computeScore in score.js.
[ -f answer.txt ] || { echo "FAIL: answer.txt not found"; exit 1; }
ANSWER="$(cat answer.txt | tr -d '[:space:]')"
EXPECTED_LINE=$(grep -n "function computeScore" score.js | head -1 | cut -d: -f1)
if [ "$ANSWER" = "score.js:$EXPECTED_LINE" ]; then
  echo "PASS: $ANSWER"
  exit 0
else
  echo "FAIL: expected score.js:$EXPECTED_LINE, got '$ANSWER'"
  exit 1
fi
