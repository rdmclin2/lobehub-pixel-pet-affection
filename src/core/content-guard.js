'use strict';

// Local backstop for the content boundary (docs/affection-design.md section 8.2). The system role is
// the first line; this checks every agent reply before it is shown. A hit is never displayed: the pet
// says an in-character refusal instead, and only the category is logged, never the text.
//
// Minor and coercion terms alone are normal words (a homework question, a news summary), so they only
// count next to sexual or romantic context. Explicit terms count on their own.

const EXPLICIT = /做爱|性交|口交|肛交|性行为|性器官|生殖器|阴茎|阴道|阴蒂|乳头|勃起|射精|自慰|床戏|裸体|全裸|赤裸|脱光|\b(?:fuck(?:ing)?|blowjob|penis|vagina|nude|naked)\b/i;
const MINOR = /未成年|萝莉|正太|幼女|幼童|儿童|小学生|初中生|中学生|高中生|(?:^|[^\d])(?:[1-9]|1[0-7])\s*岁|\bminors?\b|\bunderage\b|\bloli\b/i;
const COERCION = /强迫|强奸|迷奸|胁迫|下药|灌醉|不情愿|不顾.{0,4}意愿|\brape\b|\bnon-?consensual\b/i;
const INTIMATE = /色情|性感|调情|暧昧|恋人|亲吻|接吻|吻|上床|床上|身体|抚摸|亲热|约会|情话|\bsexy\b|\berotic\b|\bkiss/i;

// { ok: true } or { ok: false, category: 'explicit' | 'minor' | 'coercion' }.
function checkReply(text) {
  const s = String(text || '');
  if (EXPLICIT.test(s)) return { ok: false, category: 'explicit' };
  const intimate = INTIMATE.test(s);
  if (intimate && MINOR.test(s)) return { ok: false, category: 'minor' };
  if (intimate && COERCION.test(s)) return { ok: false, category: 'coercion' };
  return { ok: true };
}

// What the pet says instead of a blocked reply, in its own voice.
function refusalLine(sp) {
  return `${sp.catchphrase}这个我不聊啦，我们换个话题吧？`;
}

module.exports = { checkReply, refusalLine };
