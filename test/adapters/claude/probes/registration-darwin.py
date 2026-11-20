"""Offline macOS probe. Print one JSON record per observation (synthetic values only)."""
import argparse
import hashlib
import copy
import json
from pathlib import Path
import platform
import shutil
import subprocess as sp
import tempfile

HERE = Path(__file__).resolve().parent
PIN = '85d8c08707fcfd1e78ffa0204eefbc6ec9e4fe22f375fb2767ef85d957ed3161'



def emit(**row):
    print(json.dumps(row), flush=True)


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + '\n')


def lifecycle(run, binary, project, home, variant):
    config = home / '.claude'
    paths = {'project':project/'.claude/settings.json','local':project/'.claude/settings.local.json',
             'user':config/'settings.json','known':config/'plugins/known_marketplaces.json',
             'installed':config/'plugins/installed_plugins.json'}
    name = 'fixture-market'
    subject, neighbor = 'workspace@'+name, 'neighbor@'+name
    market = project/'market'
    write(market/'.claude-plugin/marketplace.json',{'name':name,'owner':{'name':'Fixture'},
          'plugins':[{'name':p,'source':'./'+p} for p in ['workspace','neighbor']]})
    source = market/'workspace/.claude-plugin/plugin.json'
    write(source,{'name':'workspace','version':'1.0.0'})
    write(market/'neighbor/.claude-plugin/plugin.json',{'name':'neighbor','version':'1.0.0'})
    callbacks = [{'type':'command','command':'printf neighbor'}, {'type':'command','command':'printf subject','timeout':4}]
    hooks = {event:[{'hooks':copy.deepcopy(callbacks)}, {'hooks':[{'type':'command','command':'printf after','timeout':30}]}]
             for event in ['Stop','SessionStart','PreToolUse','PostToolUse','PostToolUseFailure']}
    for event in hooks.keys()-{'Stop'}:
        hooks[event][0]['matcher'] = 'startup|resume' if event=='SessionStart' else 'AskUserQuestion|AskQuestion|request_user_input'
    hooks['PostToolUse'].insert(1,{'matcher':'mcp__sample_tools__(read_one|write_two)','hooks':copy.deepcopy(callbacks)})
    hooks['PostToolUse'].append({'matcher':'mcp__box2__(lookup|list_v2)','hooks':copy.deepcopy(callbacks)})
    obj = {'hooks':hooks,'enableAllProjectMcpServers':True,'skillOverrides':{'fixture':'off'},
           'enabledPlugins':{subject:True},'extraKnownMarketplaces':{name:{'source':{'source':'directory','path':str(market)}}}}
    obj['enabledPlugins'][neighbor] = True
    obj['enabledPlugins']['disabled@fixture-other'] = False
    obj['extraKnownMarketplaces']['fixture-other'] = {'source':{'source':'directory','path':str(project/'other-market')}}
    extended = variant == 'extended'
    undeclared = variant == 'undeclared'
    own_source = obj['extraKnownMarketplaces'][name]
    if undeclared:
        del obj['extraKnownMarketplaces'][name],obj['enabledPlugins'][subject]
    if extended:
        obj['hooks']['PreToolUse'][0]['externalFixtureField'] = 'do not drop'
    paths['receipt'] = project/'fixture-ownership.json'
    write(paths['receipt'],{'owner':'fixture'})
    write(paths['project'],obj)
    for key in ['local','user']:
        write(paths[key],{'env':{'FIXTURE':key}})

    def snap():
        return {k:p.read_text() if p.is_file() else None for k,p in paths.items()}

    def step(label,*args):
        before = snap()
        r = run(binary,'plugin',*args)
        after = snap()
        emit(step=label,before=before,after=after)
        return r,after

    def equal(label, actual, expected):
        # JSON encoding distinguishes booleans from numbers; object key order is non-semantic.
        ok = json.dumps(actual,sort_keys=True)==json.dumps(expected,sort_keys=True)
        emit(check=label,passed=ok)
        if not ok:
            raise SystemExit('mismatch: '+label)

    def observed(label, args, code, expected, mutable=()):
        before = snap()
        r,after = step(label,*args)
        equal(label+':exit',r.returncode,code)
        current = json.loads(after['project'])
        equal(label+':project key set',sorted(current),sorted(expected))
        for field in expected:
            equal(label+':'+field,current[field],expected[field])
        for key in before.keys()-{'project',*mutable}:
            equal(label+':'+key+' bytes',after[key],before[key])
        return r,after

    def identity(state, plugin, version):
        registry = json.loads(state['installed'])
        equal('registry version',registry['version'],2)
        rows = registry['plugins'][plugin]
        equal(plugin+':one entry',len(rows),1)
        equal(plugin+':identity',[rows[0][k] for k in ['scope','projectPath','version']],
              ['project',str(project),version])
        equal(plugin+':installPath',rows[0]['installPath'],str(config/'plugins/cache'/name/plugin.split('@')[0]/version))
        return rows

    add = ('marketplace','add',str(market),'--scope','project')
    # Exact fixture oracle; not a general schema validator and not the production guard.
    baseline = snap()
    supported = copy.deepcopy(obj)
    supported['hooks']['PreToolUse'][0].pop('externalFixtureField',None)
    calls = []
    def enter(version):
        if version=='2.1.311' and json.loads(paths['project'].read_text())==supported:
            calls.append('add')
    enter('2.1.310')
    if extended:
        enter('2.1.311')
    equal('unsupported version/shape: no mutation scheduled',calls,[])
    equal('unsupported: targets unchanged',snap(),baseline)
    if extended:
        return
    if undeclared:
        obj['extraKnownMarketplaces'][name]=own_source
    _,state = observed('add-old',add,0,obj,['known'])
    known=json.loads(state['known'])
    equal('add: known ids',list(known),[name])
    equal('add: known source',known[name]['source'],obj['extraKnownMarketplaces'][name]['source'])
    equal('add: installLocation',known[name]['installLocation'],str(market))
    _,state=observed('neighbor',['install',neighbor,'--scope','project'],0,obj,['installed'])
    saved_neighbor=identity(state,neighbor,'1.0.0')
    equal('neighbor: only installed entry',list(json.loads(state['installed'])['plugins']),[neighbor])
    (market/'workspace').rename(market/'offline')
    install=['install',subject,'--scope','project']
    r,_=observed('missing',install,1,obj)
    equal('missing: diagnosis','Source path does not exist' in r.stderr,True)
    # Three-way recovery oracle: only retry from the exact observed failed image.
    failed=snap()
    edit=copy.deepcopy(obj)
    edit['hooks']['PreToolUse'][0]['hooks'].insert(1,{'type':'command','command':'printf new-neighbor'})
    write(paths['project'],edit)
    third=snap()
    def recover(expected, action):
        if snap() != expected:
            return 'conflict'
        return action()
    equal('third state: refuses retry',recover(failed,lambda:step('unexpected-retry',*install)),'conflict')
    equal('third state: stopped, bytes intact',snap(),third)
    # Explicit fixture repair reconciles to the *edited* state; never restore old settings.
    obj=edit
    if undeclared:
        obj['enabledPlugins'][subject]=True
    (market/'offline').rename(market/'workspace')
    _,state=recover(third,lambda:observed('retry',install,0,obj,['installed']))
    identity(state,subject,'1.0.0')
    equal('retry: neighbor intact',identity(state,neighbor,'1.0.0'),saved_neighbor)
    exact=snap()
    observed('repeat',install,0,obj)
    equal('repeat: bytes',snap(),exact)
    write(source,{'name':'workspace','version':'1.0.1'})
    _,state=observed('update',['update',subject,'--scope','project'],0,obj,['installed'])
    identity(state,subject,'1.0.1')
    equal('update: neighbor intact',identity(state,neighbor,'1.0.0'),saved_neighbor)
    equal('update: only two ids',sorted(json.loads(state['installed'])['plugins']),sorted([subject,neighbor]))
    _,state=observed('add-existing',add,0,obj)
    equal('existing: known source',json.loads(state['known'])[name]['source'],own_source['source'])
    r,_=observed('list',['list','--json'],0,obj)
    for row in json.loads(r.stdout):
        equal('list: readFromFolder',row['readFromFolder'],str(market/row['id'].split('@')[0]))
    equal('public list',sorted((row['id'],row['scope'],row['projectPath'],row['version'],row['enabled'])
          for row in json.loads(r.stdout)),sorted([(subject,'project',str(project),'1.0.1',True),
          (neighbor,'project',str(project),'1.0.0',True)]))


def probe(base, variant):
    fixture = base / 'fixture'
    project = fixture / 'project'
    home = fixture / 'home'
    tmp = fixture / 'tmp'
    for path in [home, tmp, project]:
        path.mkdir(parents=True)
    env = dict(HOME=str(home), CLAUDE_CONFIG_DIR=str(home / '.claude'), TMPDIR=str(tmp))
    sentinel = base / 'outside'
    sentinel.write_text('outside')
    binary = base / 'claude'
    control = base / 'control'
    shutil.copyfile(BIN, binary)
    binary.chmod(0o500)
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    emit(arch=platform.machine(), macOS=platform.mac_ver()[0], sha256=digest)
    if digest != PIN:
        raise SystemExit('unexpected binary')
    sp.run(['/usr/bin/clang', HERE / 'registration-seatbelt.c', '-o', control], check=True,
           env={'PATH':'/usr/bin:/bin','HOME':str(home),'TMPDIR':str(tmp)}, cwd=base)
    # Allow only immutable programs, not executable files from the writable fixture.
    profile = '''(version 1)(deny default)(import "dyld-support.sb")
    (allow process-exec* (literal (param "BIN")) (literal (param "CONTROL")))
    (allow file-read* file-map-executable (literal (param "BIN")) (literal (param "CONTROL"))
       (subpath "/usr/lib") (subpath "/System/Library/Frameworks") (subpath "/System/Library/PrivateFrameworks"))
    (allow file-read* file-write* (subpath (param "FIXTURE")))
    (allow file-read-metadata (path-ancestors (param "FIXTURE")))
    (allow file-read* (literal "/dev/null") (literal "/dev/urandom") (subpath "/usr/share/icu"))
    (allow sysctl-read)(allow signal (target self))
    (deny network*)(deny mach-lookup)(deny file-read* file-write* (subpath "/Users") (subpath "/Library/Keychains"))'''
    prefix = ['/usr/bin/sandbox-exec', '-D', 'BIN='+str(binary), '-D', 'CONTROL='+str(control),
              '-D', 'FIXTURE='+str(fixture), '-p', profile]

    def run(program, *args):
        r = sp.run([*prefix, program, *args], cwd=project, env=env, stdin=sp.DEVNULL,
                   capture_output=True, text=True, timeout=45, close_fds=True)
        emit(argv=[program.name,*map(str,args)], exit=r.returncode, stdout=r.stdout, stderr=r.stderr)
        return r

    if run(control, sentinel).returncode or sentinel.read_text() != 'outside':
        raise SystemExit('isolation controls failed; native not run')
    v = run(binary, '--version')
    if v.returncode or v.stdout.strip() != '2.1.311 (Claude Code)':
        raise SystemExit('version not verified; no mutator invoked')
    lifecycle(run, binary, project, home, variant)
    if variant == 'supported':
        sp.run([shutil.which('node'), HERE / 'package-registration.mjs', fixture, binary, json.dumps(prefix)],check=True)
        sp.run([shutil.which('node'), HERE / 'package-registration.mjs', fixture, binary, json.dumps(prefix),'alias'],check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('binary',type=Path)
    BIN = parser.parse_args().binary.resolve(strict=True)
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('requires macOS arm64')
    for variant in ['supported','extended','undeclared']:
        with tempfile.TemporaryDirectory(prefix='registration-', dir='/private/tmp') as d:
            emit(fixture=variant)
            probe(Path(d),variant)
