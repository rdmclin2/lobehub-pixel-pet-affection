'use strict';
// A test-only character that allows adult content and has art for every outfit. Every shipped
// model-chan is all-ages, so the 18+ gating (stages, topics, outfits) is exercised through this one.
const { registerCharacter, SPECIES } = require('../../src/core/species');
const { OUTFIT_IDS } = require('../../src/core/outfits');

const ID = 'testchan';
if (!SPECIES[ID]) {
  registerCharacter({
    id: ID,
    vendor: 'Test',
    name: 'Testchan',
    nameZh: '测试娘',
    title: '测试娘 · 成人向夹具',
    accent: '#336699',
    blurb: '只在测试里出现。',
    personality: '你是测试用的成年角色（设定年龄 25 岁以上），热情、急性子。',
    catchphrase: '噼啪！',
    likes: '测试用例',
    fallback: { hungry: ['饿了。'], bored: ['好无聊。'], happy: ['开心！'], sleepy: ['困了……'], greet: ['你来啦！'] },
    adult: true,
    outfits: OUTFIT_IDS,
    art: { kind: 'pack', packs: ['testchan-pixel'] },
    credits: ['测试夹具'],
  });
}
module.exports = { ID };
