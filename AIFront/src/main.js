import Vue from 'vue'
import App from './App.vue'
import router from './router'
import store from './store'

import ElementUI from 'element-ui'
import 'element-ui/lib/theme-chalk/index.css'

// 代码编辑器（基于 CodeMirror）
import VueCodemirror from 'vue-codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/theme/material.css'
import 'codemirror/mode/javascript/javascript.js'
import 'codemirror/mode/vue/vue.js'
import 'codemirror/mode/css/css.js'
import 'codemirror/mode/xml/xml.js'
import 'codemirror/mode/htmlmixed/htmlmixed.js'
import 'codemirror/addon/hint/show-hint.css'
import 'codemirror/addon/hint/show-hint.js'
import 'codemirror/addon/hint/anyword-hint.js'
import 'codemirror/addon/edit/closetag.js'
import 'codemirror/addon/edit/closebrackets.js'
import 'codemirror/addon/selection/active-line.js'
import 'codemirror/addon/edit/matchbrackets.js'

import './styles/index.css'
import { installConsoleCapture } from './utils/consoleCapture'

Vue.config.productionTip = false

Vue.use(ElementUI)
Vue.use(VueCodemirror)

// 采集浏览器控制台 / Vue 运行时错误，供 /panda 排查页面报错
installConsoleCapture(Vue)

new Vue({
  router,
  store,
  render: h => h(App)
}).$mount('#app')

