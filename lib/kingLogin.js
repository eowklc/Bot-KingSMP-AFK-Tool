'use strict';
const { EventEmitter } = require('events');

function attachKingLogin(bot, account, config) {
  const emitter = new EventEmitter();
  let hasLoggedIn = false;
  let hasEnteredSMP = false;
  let afkTimer = null;
  const log = (msg) => emitter.emit('log', msg);

  function randomAntiAfk() {
    if (afkTimer) clearInterval(afkTimer);
    afkTimer = setInterval(() => {
      if (!bot.entity) return;
      const roll = Math.random();
      try {
        if (roll < 0.4) {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 200);
        } else if (roll < 0.7) {
          bot.look(bot.entity.yaw + (Math.random() - 0.5) * 0.6, bot.entity.pitch, true);
        } else if (roll < 0.9) {
          bot.swingArm('right');
        } else {
          bot.setControlState('forward', true);
          setTimeout(() => bot.setControlState('forward', false), 250);
        }
      } catch (_) {}
    }, config.afkIntervalMs || 30000);
  }

  bot.on('spawn', () => {
    log('Bot da spawn!');
    if (!hasLoggedIn) {
      hasLoggedIn = true;
      const cmd = (config.defaultLoginCommand || '/login {password}').replace('{password}', account.password);
      bot.chat(cmd);
      log('Da gui login: ' + cmd);
      setTimeout(() => {
        try {
          if (bot.entity) bot.look(bot.entity.yaw, -0.2);
          bot.setQuickBarSlot(4);
          setTimeout(() => {
            try { bot.swingArm('right'); bot.activateItem(); }
            catch (e) { log('Loi activateItem: ' + e.message); }
          }, 800);
        } catch (e) { log('Loi look/slot: ' + e.message); }
      }, config.enterDelayMs || 8000);
    } else {
      if (!hasEnteredSMP) {
        hasEnteredSMP = true;
        log('Da vao KingSMP! Anti-AFK bat dau...');
        randomAntiAfk();
        emitter.emit('entered');
      }
    }
  });

  bot.once('windowOpen', (window) => {
    const slot = config.menuSlot !== undefined ? config.menuSlot : 24;
    log('Menu mo! Click slot ' + slot);
    setTimeout(() => {
      try { bot.clickWindow(slot, 0, 0); log('Da click slot ' + slot); }
      catch (e) { log('Loi click: ' + e.message); }
    }, config.menuDelayMs || 2500);
  });

  bot.on('end', () => {
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
    hasLoggedIn = false;
    hasEnteredSMP = false;
  });

  return emitter;
}

module.exports = { attachKingLogin };
