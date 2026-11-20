import test from 'node:test';
import {assertNative} from '../../hooks/native-fixture.mjs';
test('Codex keeps before and after tool events in distinct groups',t => {
  assertNative(t,'codex','.codex/hooks.json',[
    {owner:'begin',event:'PreToolUse',command:'begin',matcher:'Bash',timeout:4},
    {owner:'end',event:'PostToolUse',command:'end',timeout:30},
  ],{hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'begin',timeout:4}]}],PostToolUse:[{hooks:[{type:'command',command:'end',timeout:30}]}]}});
});
