/**
 * Panda Agent 对外入口
 */
const { runPandaAgent } = require('./agent')

module.exports = {
  runPandaAgent,
  createSession: require('./session').createSession,
  listSessions: require('./session').listSessions,
  deleteSession: require('./session').deleteSession,
  loadRecentTranscript: require('./session').loadRecentTranscript
}

