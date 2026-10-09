"use strict";

const weights = { base: 10, bonus: 2 };

// score for one player
function computeScore(player) {
  return weights.base + player.extra * weights.bonus;
}

module.exports = { computeScore };
