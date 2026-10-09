#!/bin/bash
# PASS iff hello.txt exists with exactly the expected single line.
[ -f hello.txt ] || { echo "FAIL: hello.txt not found"; exit 1; }
if [ "$(cat hello.txt)" = "Hello, Loom!" ]; then
  echo "PASS: content matches"
  exit 0
else
  echo "FAIL: content is: $(cat hello.txt | head -1)"
  exit 1
fi
