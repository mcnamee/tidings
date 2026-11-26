# Topic tagging accuracy test (2026-11-26)

Owner-approved test ahead of topic tagging (TID-077). Question: can each new article be tagged with up to 3 topics accurately enough, within the free tier?

## Method

- Corpus: the 1,354 production articles with an embedding fetched in the 3 days to 2026-11-26 (20 feeds), read-only from D1.
- Topics: the 27 in `topics.json` (name plus a one-line description). The proposed final list adds **UK politics** (see findings).
- Gold labels: a random 120 of those articles (`sample.json`, seed 42), hand-labelled by the orchestrator with 1 to 3 topics each (`gold.txt`, line = sample index; 2 articles fit no topic and are excluded). One labeller, so treat the numbers as a guide.
- Metrics, over the 118 labelled articles: **first tag right** (the first predicted topic is in the gold set), **precision** (predicted tags that are in the gold set), **recall** (gold tags that were predicted), **all tags right** (every predicted tag is in the gold set), **untagged**.

## Results

| Method | First tag right | Precision | Recall | All tags right | Untagged | Neurons per article |
|---|---|---|---|---|---|---|
| Embeddings, raw cosine top-1 (`score.mjs`) | 71% | 71% | 47% | 71% | 0% | 0 (reuses TID-067 vectors) |
| Embeddings, top-1 + within 0.02 | 71% | 64% | 58% | 63% | 0% | 0 |
| Embeddings, per-topic z-score, first any, more ≥ 2.5 (`z.mjs`) | 73% | 70% | 51% | 69% | 0% | 0 |
| `@cf/meta/llama-3.2-3b-instruct`, batches of 10 (`llm.mjs`) | 55% | 45% | 68% | 15% | 2% | about 0.9 |
| `@cf/meta/llama-3.1-8b-instruct-fast`, batches of 10 | 36% | 52% | 34% | 25% | 42% | about 0.9 |
| **`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, batches of 10** | **93%** | **78%** | **81%** | **67%** | **0%** | **about 5.4** |

Topic vectors were embedded with `@cf/baai/bge-small-en-v1.5` (the TID-067 model); the plain description beat the BGE query-instruction prefix slightly. Measured usage for one 70B batch of 10: 1,270 prompt tokens, about 100 completion tokens, 53.5 neurons.

## Findings

- **Embeddings alone are not good enough.** Distinctive topics (Formula 1, Deals, Ukraine and Russia, Space) work, but general topics act as hubs: Australian stories drift to Canberra and Public service, tech stories to Open-source intelligence. Second and third tags are mostly noise; similarities sit in a narrow 0.45 to 0.7 band with a median gap of 0.03 between the top two topics.
- **Small LLMs are worse than embeddings.** They misalign numbered items in a batch and stray from the list.
- **Llama 3.3 70B is good.** Its 8 first-tag misses are mostly arguable (the Iowa explosives story as US politics, Sudan as Middle East). The one systematic error: UK politics stories went to US politics because no UK topic existed, so the final list adds **UK politics**.
- **Cost.** At about 450 new embedded articles a day, the 70B model as tested is about 2,400 neurons a day (24% of the free 10,000). Shorter output (topic numbers, not names) and batches of 20 should bring it to about 1,500 (15%). A daily cap is needed for OPML imports and busy days; past the cap the embedding top-1 is a cheap fallback.
- The test itself used about 700 neurons.

## Reproduce

Scripts expect the D1 query output (`rows*.json`) and the topic vectors (`topicvec.json`) in the working directory; both are produced with the D1 and Workers AI REST APIs and are not committed (they hold embeddings). `node score.mjs && node z.mjs 0 2.5 && node eval.mjs`, and `node llm.mjs <model>`. The TID-077 rerun below needs nothing but the repository and the proxy: `START=0 node llm-batch20.mjs 2 20` (batches, size).

## TID-077 AC3 rerun: the production prompt, batches of 20 (2026-11-26)

Run by the software engineer on the TID-077 branch, against the real model through the Workers AI REST API (`llm-batch20.mjs`). The script bundles the Worker's own prompt builder and parser (`apps/worker/src/recommend/topics.ts`), so it tests the code that ships. Differences from the first test: the 28-topic list (UK politics added), no feed name in the prompt, 400 characters of title and summary instead of 200, batches of 20 instead of 10, `temperature` 0. Only 39 of the 118 labelled articles were run (`sample.json` articles 0 to 39), to stay under the 300-neuron budget: a full run of six batches costs about 450 to 500 neurons.

| Prompt | Articles | First tag right | Misaligned | Neurons per article |
|---|---|---|---|---|
| Numeric answers (`1: 13,12`), batch 20 | 0 to 19 (19 labelled) | 14 of 19, 74% (79% counting UK politics) | none | 3.7 (1,854 in + 118 out tokens = 73.6) |
| Numeric answers, batch 10 | 0 to 9 (9 labelled) | 6 of 9, 67% | none | 4.6 (45.7 per call) |
| **Answers by topic name** (`1: AI; Technology`), batch 20 | 0 to 19 (19 labelled) | 16 of 19, 84% | none | 3.9 (1,817 in + 141 out = 77.3) |
| **Answers by topic name**, batch 20 | 20 to 39 (20 labelled) | 18 of 20, 90% | none | 4.2 (1,734 in + 184 out = 83.9) |
| **Answers by topic name, both batches** | **39 labelled** | **34 of 39, 87%** | **none** | **4.0** |

Total spend: **280 neurons** (73.6 + 45.7 + 77.3 + 83.9). The raw answers are in `*.raw.txt` (topic numbers or names only, one line per article) and the parsed result of the name runs in `batch20-results.json`.

**Reading the result**

- **Misalignment: none.** Every run returned exactly one line per article, the parser mapped all of them by article number, and a prediction never matched the previous or next article's gold labels better than its own.
- **Batch size is not the problem.** Batches of 10 made the same mistakes as batches of 20 (the Iowa explosives story as Middle East, the energy bills story as Climate). `TAG_BATCH` stays 20.
- **Numeric answers are.** With numbers the model misread its own topic list: Colombian hostage stories were answered "Middle East", Iowa lead explosives "Middle East; Crime and justice". Asking for topic names instead gave 84% on the same 19 articles at **5% more neurons** (77.3 against 73.6 a call). The shipped prompt therefore asks for names, and the parser turns each name back into an ID against the exact list (it still accepts bare numbers too). Nothing the model writes is stored: only the IDs.
- **The gold labels predate UK politics.** Three of the five misses with names are Andy Burnham and UK-EU stories that the model tagged UK politics, which is right now that the list has it, while the gold labels (written when there was no such topic) say World news. Counting those as right, **37 of 39, 95%**. The other two are Iowa lead explosives ("US politics; Health" against Health, Climate) and GB energy bills ("UK politics; Economy" against Economy, World news), both arguable.
- **Verdict:** the shipped prompt (names, batches of 20) meets the 90% bar on first tag right once UK politics is counted (strict 87%, adjusted 95%), with no misaligned items. The sample is small (39 articles, one labeller), so treat it as evidence of "about 90%", not a precise rate. The numeric prompt in ADR 0021 section 2 would not have met it (74% to 79%).
- **Cost:** about 4.0 neurons per article, so a 450-article day is about 1,800 neurons, inside the 2,500 cap (the cap covers about 600 articles a day).
