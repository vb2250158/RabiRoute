"""Import public voice facts from the official page's MDContent; never execute page scripts."""
import json,re,sys
from pathlib import Path
source=Path(sys.argv[1]).read_text('utf8')
model=None;voices={}
emotions={'开心':'happy','愉悦':'happy','悲伤':'sad','生气':'angry','愤怒':'angry','惊讶':'surprised','恐惧':'fear','厌恶':'hate','激动':'excited','兴奋':'excited','冷漠':'coldness','中性':'neutral','沮丧':'depressed','撒娇':'lovey-dovey','害羞':'shy','安慰鼓励':'comfort','咆哮/焦急':'tension','温柔':'tender','低语':'ASMR','温暖':'warm','深情':'affectionate','权威':'authoritative'}
for title,ident in re.findall(r'([^，：\n]+?)[（(]\s*`([^`]+)`\s*[）)]',source):
    title=title.replace('**','').strip()
    emotions[re.sub(r'\s*/\s*','/',title)]=ident
emotions['ASMR']='ASMR'
for line in source.splitlines():
    if line.startswith('## '):
        model='seed-tts-2.0' if '豆包语音合成模型2.0' in line else 'seed-tts-1.0' if '豆包语音合成模型1.0' in line else None
    if not model or not line.startswith('|'):continue
    cells=[re.sub(r'<br\s*/?>',' ',v.strip()).replace('\\-','-') for v in line.split('|')[1:-1]]
    if len(cells)<5 or not re.fullmatch(r'[A-Za-z0-9_-]+',cells[2]) or cells[2]=='voice_type':continue
    ident=cells[2];info=' '.join(cells[4:])
    labels=[re.sub(r'\s*/\s*','/',e.strip()) for e in re.split('[、，,]',cells[4])]
    options=[{'id':emotions[e],'label':e} for e in labels if e in emotions] if model=='seed-tts-1.0' else []
    voices[ident]={'id':ident,'label':cells[1].replace('**',''),'model':model,'languages':cells[3],'bidirectional':'不支持双向流' not in info,'instruction':'指令遵循' in info or 'QA' in cells[4:],'emotions':options}
out=Path(sys.argv[2])
out.write_text('// Public voice catalog facts from https://www.volcengine.com/docs/6561/1257544 (2026-11-08).\nexport const volcanoVoices = '+json.dumps(list(voices.values()),ensure_ascii=False,separators=(',',':'))+';\n','utf8')
print(json.dumps({'count':len(voices),'v2':sum(v['model']=='seed-tts-2.0' for v in voices.values()),'v1':sum(v['model']=='seed-tts-1.0' for v in voices.values())}))
