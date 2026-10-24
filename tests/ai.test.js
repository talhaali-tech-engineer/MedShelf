import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ai from '../js/ai.js';

// Made-up keys in the right shape. They are never sent anywhere: every test fakes fetch.
const OPENAI = ai.cleanAiConfig({ apiKey: 'sk-test-0000000000000000000000' });
const CLAUDE = ai.cleanAiConfig({ apiKey: 'sk-ant-test-000000000000000000' });

/** A fake fetch that answers with the given body (string chunks are streamed) and records the request. */
function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (Array.isArray(body)) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of body) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status });
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('the assistant is held to inventory work and never told to promote medicine', () => {
  const system = ai.assistantSystem('Paracetamol 500 mg | 10 | ...');
  assert.match(system, /inventory administration only/);
  assert.match(system, /does not prescribe, diagnose, recommend treatment or replace a pharmacy dispensing system/);
  assert.match(system, /Never suggest promoting, discounting, advertising or selling more/);
  assert.match(system, /authorised staff review/);
  assert.doesNotMatch(system, /sell first|sold per day|unsold/i);
});

test('detectProvider tells OpenAI and Claude keys apart', () => {
  assert.equal(ai.detectProvider('sk-proj-abcdefghijklmnopqrstuv'), 'openai');
  assert.equal(ai.detectProvider('sk-ant-api03-abcdefghijklmnop'), 'anthropic');
  assert.equal(ai.detectProvider('hello'), null);
  assert.equal(ai.detectProvider('sk-has spaces in it 12345678'), null);
});

test('cleanAiConfig picks a model that matches the key', () => {
  assert.equal(OPENAI.model, 'gpt-4o');
  assert.equal(CLAUDE.model, 'claude-opus-5-5');
  assert.equal(ai.cleanAiConfig({ apiKey: CLAUDE.apiKey, model: 'gpt-4o' }).model, 'claude-opus-5-5');
  assert.equal(ai.cleanAiConfig({ apiKey: OPENAI.apiKey, model: 'gpt-4o-mini' }).model, 'gpt-4o-mini');
  assert.deepEqual(ai.cleanAiConfig({ apiKey: 'nope' }), { apiKey: '', provider: null, model: '' });
});

test('chat requests have the right shape for each provider', () => {
  const input = { system: 'S', messages: [{ role: 'user', content: 'Hi' }] };
  const o = ai.buildChatRequest(OPENAI, input);
  assert.equal(o.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(o.headers.authorization, `Bearer ${OPENAI.apiKey}`);
  assert.deepEqual(o.body.messages[0], { role: 'system', content: 'S' });
  assert.equal(o.body.stream, true);

  const c = ai.buildChatRequest(CLAUDE, input);
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.headers['x-api-key'], CLAUDE.apiKey);
  assert.equal(c.headers['anthropic-version'], '2026-10-21');
  assert.equal(c.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(c.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(c.body.fallbacks, 'default');
  assert.equal(c.body.system, 'S');
  assert.equal('temperature' in c.body, false);

  const haiku = ai.buildChatRequest({ ...CLAUDE, model: 'claude-haiku-5-5' }, input);
  assert.equal('fallbacks' in haiku.body, false);
  assert.equal(haiku.headers['anthropic-beta'], undefined);
});

test('scan requests send photos and PDFs the way each provider expects', () => {
  const files = [{ mediaType: 'image/jpeg', base64: 'AAA', name: 'a.jpg' }, { mediaType: 'application/pdf', base64: 'BBB', name: 'b.pdf' }];
  const c = ai.buildScanRequest(CLAUDE, { files, known: ['Paracetamol 500 mg (Tablet)'] });
  const parts = c.body.messages[0].content;
  assert.deepEqual(parts.map((p) => p.type), ['image', 'document', 'text']);
  assert.match(parts[2].text, /Paracetamol 500 mg/);
  assert.equal(c.body.output_config.format.type, 'json_schema');

  const o = ai.buildScanRequest(OPENAI, { files, known: [] });
  const oparts = o.body.messages[1].content;
  assert.deepEqual(oparts.map((p) => p.type), ['text', 'image_url', 'file']);
  assert.equal(oparts[1].image_url.url, 'data:image/jpeg;base64,AAA');
  assert.equal(oparts[2].file.file_data, 'data:application/pdf;base64,BBB');
  assert.equal(o.body.response_format.json_schema.strict, true);
});

test('splitSSE keeps an unfinished event for the next chunk', () => {
  const [first, rest] = ai.splitSSE('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first, ['{"a":1}']);
  const [second] = ai.splitSSE(`${rest}:2}\n\n`);
  assert.deepEqual(second, ['{"b":2}']);
});

test('streamChat assembles a Claude reply split across awkward chunks', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Remove "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"28 units."}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ].join('');
  const chunks = [events.slice(0, 50), events.slice(50, 170), events.slice(170)];
  const { fetchImpl, calls } = fakeFetch(200, chunks);
  const seen = [];
  const out = await ai.streamChat(CLAUDE, { system: 'S', messages: [{ role: 'user', content: 'Q' }] }, (t) => seen.push(t), { fetchImpl });
  assert.equal(out.text, 'Remove 28 units.');
  assert.equal(out.stop, 'end_turn');
  assert.deepEqual(seen, ['Remove ', 'Remove 28 units.']);
  assert.equal(calls[0].body.stream, true);
});

test('streamChat reads OpenAI chunks and the [DONE] marker', async () => {
  const { fetchImpl } = fakeFetch(200, [
    'data: {"choices":[{"delta":{"content":"Order "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"650."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ]);
  const out = await ai.streamChat(OPENAI, { system: 'S', messages: [] }, () => {}, { fetchImpl });
  assert.equal(out.text, 'Order 650.');
});

test('a rejected key gives a plain message that never repeats the key', async () => {
  const { fetchImpl } = fakeFetch(401, { error: { message: `Incorrect API key provided: ${OPENAI.apiKey}` } });
  await assert.rejects(
    ai.streamChat(OPENAI, { system: 'S', messages: [] }, () => {}, { fetchImpl }),
    (err) => err instanceof ai.AiError && /not accepted/.test(err.message) && !err.message.includes(OPENAI.apiKey),
  );
});

test('scanDelivery turns packs into units and drops bad fields', async () => {
  const reply = {
    supplier: ' Northwind Pharma ',
    warnings: ['Ibuprofen expiry not readable', 42],
    items: [
      { name: 'Amoxicillin', strength: '500 mg', form: 'Capsule', batch: 'AMX9', expiry: '2027-04', quantity: 3, pack_size: 100, price: 8 },
      { name: 'Salbutamol inhaler', strength: '100 mcg', form: 'Inhaler', batch: 'S1', expiry: '2027-01', quantity: 6, pack_size: null, price: 1.5 },
      { name: 'Ibuprofen', strength: '', form: 'Tablet', batch: '', expiry: '', quantity: -5, pack_size: 24, price: 'cheap' },
      { name: '', strength: '', form: '', batch: '', expiry: '', quantity: 1, pack_size: null, price: null },
    ],
  };
  const { fetchImpl } = fakeFetch(200, { content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn' });
  const out = await ai.scanDelivery(CLAUDE, { files: [{ mediaType: 'image/jpeg', base64: 'AAA' }], known: [] }, { fetchImpl });
  assert.equal(out.supplier, 'Northwind Pharma');
  assert.deepEqual(out.warnings, ['Ibuprofen expiry not readable']);
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items[0], { name: 'Amoxicillin', strength: '500 mg', form: 'Capsule', batchNo: 'AMX9', expiry: '2027-04', qty: 300, unitCost: 0.08, packs: '3 packs of 100' });
  assert.deepEqual([out.items[1].qty, out.items[1].unitCost, out.items[1].packs], [6, 1.5, '']);
  assert.equal(out.items[2].qty, null);
  assert.equal(out.items[2].unitCost, null);
});

test('scanDelivery reads OpenAI replies and reports refusals', async () => {
  const ok = fakeFetch(200, { choices: [{ message: { content: '{"supplier":"","items":[],"warnings":[]}' }, finish_reason: 'stop' }] });
  assert.deepEqual((await ai.scanDelivery(OPENAI, { files: [{ mediaType: 'image/png', base64: 'A' }], known: [] }, { fetchImpl: ok.fetchImpl })).items, []);
  const refused = fakeFetch(200, { choices: [{ message: { content: null, refusal: 'No.' }, finish_reason: 'stop' }] });
  await assert.rejects(ai.scanDelivery(OPENAI, { files: [{ mediaType: 'image/png', base64: 'A' }], known: [] }, { fetchImpl: refused.fetchImpl }), /declined/);
});
