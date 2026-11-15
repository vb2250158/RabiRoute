export const webSearchProviders = [
  {id:'model-native',label:'跟随对话模型',hint:'WorkBuddy 使用官方登录的搜索能力；OpenAI 官方接口使用当前模型的联网搜索。'},
  {id:'tavily',label:'Tavily',hint:'使用独立搜索服务的 API Key，按该服务额度计费。',endpoint:'https://api.tavily.com/search',docs:'https://docs.tavily.com/documentation/api-reference/endpoint/search'},
];
export const webSearchDefinitions = {
  webSearchEnabled:{default:true},
  webSearchProvider:{default:'model-native',enum:webSearchProviders.map(item=>item.id)},
  webSearchMaxResults:{default:5,min:1,max:10,integer:true},
};
export function webSearchCredentialRef(provider){
  if(provider!=='tavily')throw Error('WEB_SEARCH_CREDENTIAL_UNAVAILABLE');
  return 'search:tavily:https://api.tavily.com';
}
