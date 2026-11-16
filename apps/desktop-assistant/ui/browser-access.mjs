const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
/** Browser copy is scoped to this exact origin, including the port. Provider credentials never enter it. */
export function createBrowserAccess({origin,hash,storage,session,clearHash,onRequired=()=>{},fetcher=fetch}) {
  const key='assistant-access-v1';
  const read=store=>{try{return store?.getItem(key)}catch{return null}};
  const write=(store,value)=>{try{value?store?.setItem(key,value):store?.removeItem(key)}catch{}};
  let token=valid(hash?.slice(1))?hash.slice(1):read(storage)||read(session);
  if(!valid(token))token=null;
  const remember=value=>{token=value;write(storage,value);write(session,value)};
  if(hash){if(token)remember(token);clearHash()}
  return {
    hasToken:()=>Boolean(token),
    acceptLink(value){let url;try{url=new URL(value)}catch{throw Error('ASSISTANT_LINK_INVALID')}
      if(url.origin!==origin||url.pathname!=='/'||(url.search&&url.search!=='?connect=1')||!valid(url.hash.slice(1)))throw Error('ASSISTANT_LINK_INVALID');
      remember(url.hash.slice(1));
    },
    async request(path,body){
      if(!token){onRequired();throw Error('ASSISTANT_AUTH_REQUIRED')}
      const response=await fetcher('/api/'+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const result=await response.json();if(response.status===401){remember(null);onRequired();throw Error('ASSISTANT_AUTH_REQUIRED')}
      if(!response.ok)throw Error(result.error);return result;
    },
  };
}
