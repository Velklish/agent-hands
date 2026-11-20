import test from 'node:test';
import {assertNative} from '../../hooks/native-fixture.mjs';
test('Claude failure event keeps the matcher on the group',t => {
  assertNative(t,'claude','.claude/settings.json',[
    {owner:'finish',event:'PostToolUseFailure',command:'record',matcher:'AskUserQuestion|AskQuestion|request_user_input',timeout:30},
  ],{hooks:{PostToolUseFailure:[{matcher:'AskUserQuestion|AskQuestion|request_user_input',hooks:[{type:'command',command:'record',timeout:30}]}]}});
});
