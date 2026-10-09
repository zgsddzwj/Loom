#!/bin/bash
node -e '
const { add, mul } = require("./calc.js");
if (add(2, 3) !== 5) { console.log("FAIL: add(2,3) =", add(2, 3)); process.exit(1); }
if (add(-1, 1) !== 0) { console.log("FAIL: add(-1,1) =", add(-1, 1)); process.exit(1); }
if (mul(2, 3) !== 6) { console.log("FAIL: mul(2,3) =", mul(2, 3)); process.exit(1); }
console.log("PASS: calc.js correct");
'
