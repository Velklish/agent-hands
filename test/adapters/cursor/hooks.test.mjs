import test from 'node:test';
import {assertNative} from '../../hooks/native-fixture.mjs';
test('Cursor MCP before and after events use flat callbacks',t => {
  assertNative(t,'cursor','.cursor/hooks.json',[
    {owner:'begin',event:'beforeMCPExecution',command:'begin',matcher:'Read|Shell',timeout:4},
    {owner:'end',event:'afterMCPExecution',command:'end',timeout:30},
  ],{version:1,hooks:{beforeMCPExecution:[{command:'begin',matcher:'Read|Shell',timeout:4}],afterMCPExecution:[{command:'end',timeout:30}]}});
});
