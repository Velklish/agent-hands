import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverHooks } from '../../dist/hooks/hook-delivery.js';

for (const target of Object.keys({ claude:'nested',codex:'nested',cursor:'flat' })) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hook-delivery-')));
  try {
    const scope = { directory:path.join(root,'transactions'), pointers:[path.join(root,'pending')] };
    const document = path.join(root,'document');
    const state = path.join(root,'ownership');
    const intent = { owner:'subject',event:'Example',shell:{},callback:{ command:'first' } };
    const spec = { target,document,state,intents:[intent] };
    const deliver = (patch = {}) => deliverHooks(scope,[{ ...spec,...patch }],() => assert.fail('Unexpected removal'));
    deliver();
    const installed = fs.readFileSync(document,'utf8');
    deliver();
    assert.equal(fs.readFileSync(document,'utf8'),installed);
    const edited = installed.replace('first','custom');
    fs.writeFileSync(document,edited);
    const originalReceipt = fs.readFileSync(state,'utf8');
    assert.throws(() => deliver(),/missing/);
    assert.equal(fs.readFileSync(state,'utf8'),originalReceipt);
    deliver({ release:['subject'] });
    deliver({ intents:[{ ...intent,callback:{ command:'next' } }] });
    assert.equal(fs.readFileSync(document,'utf8'),edited);
    assert.deepEqual(JSON.parse(fs.readFileSync(state,'utf8')).released,['subject']);
    deliver({ restore:['subject'] });
    const restored = fs.readFileSync(document,'utf8');
    assert.ok(restored.includes('custom') && restored.includes('first'));
    deliver();
    assert.equal(fs.readFileSync(document,'utf8'),restored);
    console.log(`PASS ${target}: create, repeat, conflict, release, upgrade`);
    const pristine = { ...spec,document:path.join(root,'pristine'),state:path.join(root,'pristine-state') };
    const personal = { ...spec,document:path.join(root,'personal'),state:path.join(root,'personal-state') };
    const initial = target === 'cursor' ? { version:1,hooks:{ Example:[] } } : { hooks:{ Example:[{ hooks:[] }] } };
    fs.writeFileSync(personal.document,JSON.stringify(initial));
    deliverHooks(scope,[pristine,personal],() => assert.fail('Unexpected removal'));
    let warnings = 0;
    deliverHooks(scope,[{ ...pristine,intents:[] },{ ...personal,intents:[] }],() => warnings++);
    assert.equal(warnings,1);
    assert.equal(fs.existsSync(pristine.document),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(personal.document,'utf8')),initial);
    console.log(`PASS ${target}: only proved structure is removed`);

    if (target !== 'cursor') {
      const mixed = { ...spec,document:path.join(root,'mixed'),state:path.join(root,'mixed-state') };
      fs.writeFileSync(mixed.document,JSON.stringify({ hooks:{ Example:[{ hooks:[] }] } }));
      deliverHooks(scope,[mixed],() => assert.fail('Unexpected removal'));
      const moved = JSON.parse(fs.readFileSync(mixed.document,'utf8'));
      moved.hooks.Example[0].hooks.push(moved.hooks.Example[1].hooks.pop());
      fs.writeFileSync(mixed.document,JSON.stringify(moved));
      deliverHooks(scope,[{ ...mixed,intents:[] }],() => {});
      assert.deepEqual(JSON.parse(fs.readFileSync(mixed.document,'utf8')).hooks.Example,[{ hooks:[] },{ hooks:[] }]);
      console.log(`PASS ${target}: callback relocation does not transfer group ownership`);
    }
  } finally { fs.rmSync(root,{ recursive:true,force:true }); }
}
