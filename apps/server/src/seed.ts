import type { LexiconWord } from '@lingoweave/contracts';

// Lexical data adapted from Wiktionary contributors under CC BY-SA 4.0.
// Chinese learner glosses are project edits; IPA is transcribed from the linked revisions.
// Attribution, selection notes, and scope: docs/lexicon-sources.md.
type SeedDefinition = readonly [
  lemma: string,
  partOfSpeech: string,
  sense: string,
  meaningZh: string,
  phonetic: string | null,
  revision: number,
];

const definitions: readonly SeedDefinition[] = [
  ['apple', 'noun', 'fruit', '苹果（水果）', '/ˈæpəl/', 94495227],
  ['book', 'noun', 'bound-pages', '书；书本', '/bʊk/', 94548435],
  ['water', 'noun', 'liquid', '水', '/ˈwɔː.tə/', 95210102],
  ['read', 'verb', 'interpret-writing', '阅读；看懂文字', '/ɹiːd/', 94584767],
  ['write', 'verb', 'form-words', '写；书写文字', '/ɹaɪt/', 93802082],
  ['house', 'noun', 'dwelling', '房屋；住宅', '/haʊ̯s/', 94898383],
  ['room', 'noun', 'building-part', '房间', '/ɹuːm/', 94570303],
  ['door', 'noun', 'entrance', '门', '/dɔː/', 93758937],
  ['chair', 'noun', 'seat', '椅子', '/t͡ʃɛə/', 93683967],
  ['table', 'noun', 'furniture', '桌子', '/ˈteɪbl̩/', 93429919],
  ['food', 'noun', 'nourishment', '食物', '/fuːd/', 94555842],
  ['milk', 'noun', 'dairy-liquid', '奶；乳汁', '/mɪlk/', 94562578],
  ['bread', 'noun', 'baked-food', '面包', '/bɹɛd/', 94605749],
  ['friend', 'noun', 'person', '朋友', '/fɹɛnd/', 93802257],
  ['family', 'noun', 'relatives', '家庭；家人', '/ˈfæm(ɪ)li/', 94555078],
  ['school', 'noun', 'educational-institution', '学校', '/skuːl/', 94588148],
  ['teacher', 'noun', 'educator', '老师；教师', '/ˈti.t͡ʃɚ/', 93591011],
  ['student', 'noun', 'enrolled-learner', '学生', '/ˈstjuː.dn̩t/', 93817453],
  ['day', 'noun', 'twenty-four-hours', '一天（约二十四小时）', '/deɪ̯/', 95363288],
  ['night', 'noun', 'dark-period', '夜晚', '/naɪ̯t/', 94583588],
  ['go', 'verb', 'move-to-place', '去；前往', '/ɡəʊ/', 95367163],
  ['come', 'verb', 'move-nearer', '来；靠近', '/kʌm/', 94550559],
  ['eat', 'verb', 'consume-food', '吃（食物）', '/iːt/', 95308338],
  ['drink', 'verb', 'consume-liquid', '喝（液体）', '/ˈdɹɪŋk/', 95185624],
  ['see', 'verb', 'perceive-visually', '看见', '/siː/', 94588609],
  ['hear', 'verb', 'perceive-sound', '听见', '/ˈhɪə/', 94587483],
  ['speak', 'verb', 'say-words', '说话', '/spiːk/', 93723976],
  ['learn', 'verb', 'acquire-knowledge', '学习；获得知识或技能', '/lɜːn/', 93582931],
  ['small', 'adjective', 'little-size', '小的（体积或尺寸）', '/smɔːl/', 94593645],
  ['happy', 'adjective', 'feeling-joy', '高兴的；快乐的', '/ˈhæpi/', 94557613],
];

export const seedWords: LexiconWord[] = definitions.map(
  ([lemma, partOfSpeech, sense, meaningZh, phonetic, revision]) => ({
    id: `en:${lemma}:${partOfSpeech}:${sense}`,
    lemma,
    partOfSpeech,
    meaningZh,
    phonetic,
    sources: [
      {
        name: 'Wiktionary contributors',
        url: `https://en.wiktionary.org/w/index.php?title=${lemma}&oldid=${revision}#English`,
        license: 'CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/',
        version: `Wiktionary revision ${revision}; LingoWeave seed v1, 2026-11-03`,
      },
    ],
  }),
);
