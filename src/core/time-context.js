'use strict';

// Time background for every message (ported from dsh-pet host/time-context): the part of the day in
// nine slots, the weekday, and fixed-date festivals, so every character can mention the time of day
// or a holiday in its own voice. Lunar festivals (春节, 中秋 …) are not computed here.

const SLOTS = [
  { from: 0, to: 5, name: '凌晨' },
  { from: 5, to: 7, name: '清晨' },
  { from: 7, to: 9, name: '早上' },
  { from: 9, to: 11, name: '上午' },
  { from: 11, to: 13, name: '中午' },
  { from: 13, to: 17, name: '下午' },
  { from: 17, to: 19, name: '傍晚' },
  { from: 19, to: 23, name: '晚上' },
  { from: 23, to: 24, name: '深夜' },
];
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
// month-day → festival (公历固定日期)
const FESTIVALS = {
  '1-1': '元旦',
  '2-14': '情人节',
  '3-8': '妇女节',
  '4-1': '愚人节',
  '5-1': '劳动节',
  '10-1': '国庆节',
  '10-31': '万圣夜',
  '11-1': '万圣节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
  '12-31': '跨年夜',
};

function timeContext(d) {
  const h = d.getHours();
  const slot = SLOTS.find((s) => h >= s.from && h < s.to).name;
  const day = d.getDay();
  return { slot, weekday: WEEKDAYS[day], weekend: day === 0 || day === 6, festival: FESTIVALS[`${d.getMonth() + 1}-${d.getDate()}`] || null };
}

// "晚上，星期五，工作日，今天是万圣夜"
function describeTime(d) {
  const c = timeContext(d);
  return [c.slot, c.weekday, c.weekend ? '周末' : '工作日', c.festival ? `今天是${c.festival}` : null].filter(Boolean).join('，');
}

module.exports = { SLOTS, FESTIVALS, timeContext, describeTime };
