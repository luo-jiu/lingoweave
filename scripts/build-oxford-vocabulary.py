"""Build the personal Oxford course import from the official PDF and pinned ECDICT CSV."""

import argparse
import csv
import hashlib
import json
import re
import uuid
from collections import Counter
from pathlib import Path

from pypdf import PdfReader


LEVELS = ("A1", "A2", "B1", "B2")
POS_PATTERN = re.compile(
    r"^(.+?)\s+(indefinite article|definite article|modal v\.|auxiliary v\.|"
    r"adj\.|adv\.|noun\.|n\.|v\.|prep\.|pron\.|det\.|conj\.|exclam\.|"
    r"ordinal number|number|infinitive marker)(.*)$"
)
# The PDF distinguishes these senses explicitly. Keep their learning identities apart.
SENSES = {
    "bank (money)": ("n. 银行", None),
    "bank (river)": ("n. 河岸", None),
    "can1": ("情态动词 能；可以", None),
    "can2": ("n. 罐；罐头", None),
    "close1": ("v. 关闭；结束", "kləʊz"),
    "close2": ("adj. 近的；亲近的", "kləʊs"),
    "kind (type)": ("n. 种类", None),
    "kind (caring)": ("adj. 友善的；体贴的", None),
    "last1 (final)": ("adj. 最后的；上一个的", None),
    "last1 (taking time)": ("v. 持续；维持", None),
    "lie1": ("v. 躺；平放；位于", "laɪ"),
    "lie2 (tell a lie)": ("v. 说谎；n. 谎言", "laɪ"),
    "light (from the sun/a lamp)": ("n. 光；光线", "laɪt"),
    "light (not heavy)": ("adj. 轻的", "laɪt"),
    "like (similar)": ("prep. 像；类似", None),
    "like (find sb/sth pleasant)": ("v. 喜欢", None),
    "live1": ("v. 居住；生活", "lɪv"),
    "live2": ("adj. 现场直播的；现场演出的", "laɪv"),
    "second1 (next after the first)": ("第二；第二个", None),
    "second1 (unit of time)": ("n. 秒", None),
    "bear (animal)": ("n. 熊", None),
    "bear (deal with)": ("v. 承受；忍受", None),
    "mine (belongs to me)": ("pron. 我的东西", None),
    "mine (hole in the ground)": ("n. 矿；矿井", None),
    "race (competition)": ("n. 比赛；v. 赛跑", None),
    "race (of people)": ("n. 种族", None),
    "rest (remaining part)": ("n. 剩余部分；其余的人或物", None),
    "rest (sleep/relax)": ("n. 休息；v. 休息", None),
    "ring1": ("n. 戒指；环", None),
    "ring2": ("v. 发出铃声；打电话", None),
    "rock (music)": ("n. 摇滚乐", None),
    "rock (stone)": ("n. 岩石；石块", None),
    "wind1": ("n. 风", "wɪnd"),
    "wind2": ("v. 缠绕；蜿蜒", "waɪnd"),
    "set (group)": ("n. 一套；一组", None),
    "set (put)": ("v. 放置；设置", None),
    "stick (piece of wood)": ("n. 棍；枝条", None),
    "stick (push into/attach)": ("v. 粘贴；插入", None),
    "tear1": ("v. 撕；撕裂", "teə"),
    "tear2": ("n. 眼泪", "tɪə"),
}
COMMON = {
    "a": ("不定冠词 一；一个（用于辅音音素前）", "ə; eɪ"),
    "an": ("不定冠词 一；一个（用于元音音素前）", "ən; æn"),
    "the": ("定冠词 这个；那个；这些；那些", "ðə; ðiː"),
    "to": ("prep. 向；到；动词不定式标记", "tə; tuː"),
    "IT": ("n. 信息技术", "ˌaɪ ˈtiː"),
    "may": ("情态动词 可能；可以", "meɪ"),
    "May": ("n. 五月", "meɪ"),
    "o'clock": ("adv. ……点钟", "əˈklɒk"),
    "per cent": ("百分之……", "pə ˈsent"),
    "Wi-Fi": ("n. 无线网络", "ˈwaɪ faɪ"),
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def spelling(headword):
    result = re.sub(r"\s*\([^)]*\)", "", headword)
    result = re.sub(r"\d+$", "", result).strip().replace("’", "'").replace("™", "")
    return "a" if result == "a, an" else result


def read_wordlist(path):
    rows = []
    level = None
    for page in PdfReader(path).pages:
        for raw in page.extract_text().splitlines():
            line = " ".join(raw.split())
            if not line or line.startswith(("©", "The Oxford")):
                continue
            if line in LEVELS:
                level = line
                continue
            match = POS_PATTERN.match(line)
            if match and level:
                rows.append({"headword": match[1], "pos": match[2] + match[3], "level": level,
                             "sourceEntry": line})
            elif line in ("adj.", "number") and rows:
                rows[-1]["pos"] += " " + line
                rows[-1]["sourceEntry"] += " " + line
            else:
                raise ValueError(f"Unrecognized official word-list row: {line}")
    return rows


def meaning_for(row, dictionary):
    word = spelling(row["headword"])
    manual = SENSES.get(row["headword"]) or COMMON.get(word)
    if manual:
        return manual[0], manual[1] or dictionary.get("phonetic", "")
    translation = dictionary["translation"].replace("\\r\\n", "\n").replace("\\n", "\n")
    lines = [re.sub(r"^\[[^]]+\]\s*", "", item.strip()) for item in translation.splitlines()
             if re.search(r"[\u4e00-\u9fff]", item)]
    aliases = {"adj.": ("a.", "adj."), "v.": ("v.", "vt.", "vi."),
               "modal v.": ("aux.",), "noun.": ("n.",)}
    wanted = row["pos"].split(",")[0].strip()
    prefixes = aliases.get(wanted, (wanted,))
    selected = next((line for line in lines if line.startswith(prefixes)), lines[0] if lines else "")
    if not re.search(r"[\u4e00-\u9fff]", selected):
        raise ValueError(f"No usable Chinese meaning for {row['headword']}")
    return selected, dictionary.get("phonetic", "")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revision", type=int, default=0)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    pdf = args.source_dir / "oxford3000-cefr.pdf"
    csv_path = args.source_dir / "ecdict.csv"
    metadata_path = args.source_dir / "ecdict-source.json"
    metadata = json.loads(metadata_path.read_text())
    rows = read_wordlist(pdf)
    needed = {spelling(row["headword"]).casefold() for row in rows}
    if csv_path.exists():
        dictionary = {}
        with csv_path.open(newline="", encoding="utf-8-sig") as stream:
            for entry in csv.DictReader(stream):
                if entry["word"].casefold() in needed and entry["translation"].strip():
                    dictionary[entry["word"]] = entry
        metadata["sha256"] = sha256(csv_path)
        metadata_path.write_text(json.dumps(metadata, indent=2))
    else:
        dictionary = json.loads((args.source_dir / "ecdict-subset.json").read_text())
    folded = {key.casefold(): value for key, value in dictionary.items()}
    entries = []
    seen = set()
    for rank, row in enumerate(rows):
        headword = row["headword"]
        if headword in seen:
            continue
        seen.add(headword)
        word = spelling(headword)
        entry = dictionary.get(word) or folded.get(word.casefold()) or {}
        if not entry and word not in COMMON:
            raise ValueError(f"Missing dictionary entry: {word}")
        meaning, phonetic = meaning_for(row, entry)
        identifier = hashlib.sha256(headword.encode()).hexdigest()[:24]
        entries.append({"id": "oxford3000:" + identifier,
                        "word": {"spelling": word, "meaning": meaning, "phonetic": phonetic.replace("ә", "ə")},
                        "level": row["level"], "partOfSpeech": row["pos"],
                        "sourceEntry": row["sourceEntry"], "rank": rank})
    commit = metadata["commit"]
    sources = [
        {"id": "oxford3000", "title": "Oxford 3000 by CEFR level", "role": "wordlist",
         "url": "https://www.oxfordlearnersdictionaries.com/external/pdf/wordlists/oxford-3000-5000/The_Oxford_3000_by_CEFR_level.pdf",
         "version": "sha256:" + sha256(pdf), "sha256": sha256(pdf),
         "license": "© Oxford University Press. Official downloadable word list retained for personal study."},
        {"id": "ecdict", "title": "ECDICT Chinese meanings and phonetics", "role": "dictionary",
         "url": "https://github.com/skywind3000/ECDICT", "version": commit,
         "sha256": metadata["sha256"], "license": "MIT; preserve source LICENSE. Aggregated dictionary data with importer sense checks."},
        {"id": "lingoweave-sense-checks", "title": "LingoWeave importer sense normalizations", "role": "dictionary",
         "url": "https://github.com/skywind3000/ECDICT", "version": "personal-import-v1",
         "sha256": hashlib.sha256(json.dumps({**SENSES, **COMMON}, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
         "license": "Local normalization of the explicitly qualified word-list senses and elementary function words."},
    ]
    payload = {"requestId": str(uuid.uuid4()), "expectedRevision": args.revision,
               "id": "oxford3000", "name": "牛津 3000", "activate": args.activate,
               "sources": sources, "entries": entries}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    report = {"officialRows": len(rows), "sourceHeadwords": len(seen), "entries": len(entries),
              "spellings": len({entry['word']['spelling'].casefold() for entry in entries}),
              "levels": dict(Counter(entry["level"] for entry in entries)), "sources": sources}
    (args.output.parent / "oxford3000-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (args.source_dir / "ecdict-subset.json").write_text(json.dumps(dictionary, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "sources"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
