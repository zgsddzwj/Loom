"use strict";

function add(a, b) {
  return a - b; // BUG: subtracts instead of adds
}

function mul(a, b) {
  return a * b;
}

module.exports = { add, mul };
