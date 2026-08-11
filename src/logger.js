/**
 * logger.js — Colored console logger
 */

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

module.exports = {
  COLORS,
  
  info:    (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${msg}`),
  warn:    (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.yellow}⚠  ${msg}${COLORS.reset}`),
  error:   (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.red}❌ ${msg}${COLORS.reset}`),
  success: (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.green}✅ ${msg}${COLORS.reset}`),
  
  trade:   (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.cyan}📊 ${msg}${COLORS.reset}`),
  win:     (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.green}🏆 ${msg}${COLORS.reset}`),
  loss:    (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.red}💀 ${msg}${COLORS.reset}`),
  enter:   (msg) => console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.magenta}📥 ${msg}${COLORS.reset}`),
  
  banner:  (msg) => console.log(`\n${COLORS.bold}${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}${COLORS.reset}\n`),
  divider: ()  => console.log(`${COLORS.gray}${'─'.repeat(60)}${COLORS.reset}`),
  line:    (msg) => console.log(`  ${msg}`),
  
  debug:   (msg) => { if (process.env.DEBUG) console.log(`${COLORS.gray}[${ts()}] ${COLORS.dim}${msg}${COLORS.reset}`); },
};
