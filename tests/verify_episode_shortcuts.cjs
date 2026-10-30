const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const source = require('./frontend_source.cjs');
const settings = { record_themes: ['watch','episode_review','episode_rating','oped','other'].map(id => ({id})) };
const context = vm.createContext({state: {settings}, enabledSetting: key => settings[key] !== false});
const actions = source.slice(source.indexOf('function showEpisodeReviewRecord()'), source.indexOf('\nfunction applyTheme()'));
const themes = source.slice(source.indexOf('const RECORD_THEME_ORDER ='), source.indexOf('\nfunction recordTextFormat'));
vm.runInContext(actions + themes, context);
const ids = () => vm.runInContext('recordThemes().map(theme => theme.id).join(",")', context);
const expected = ids();
for (const [key, actions] of Object.entries({show_episode_review_record:['review'], show_episode_rating_record:['score'], show_oped_record:['op','ed']})) {
  settings[key] = false;
  assert.equal(ids(), expected, 'Quick-action switches must not hide record themes');
  for (const action of actions) assert.equal(vm.runInContext(`quickRecordActionEnabled('${action}')`, context), false);
  settings[key] = true;
  for (const action of actions) assert.equal(vm.runInContext(`quickRecordActionEnabled('${action}')`, context), true);
}
console.log('Episode shortcuts: independent toggles control quick actions without hiding record themes');
