import { IRCClient } from '../clients/irc';
import { SupportSessionManager } from '../handlers/supportSessionManager';
import { spaceNick } from '../utils';
import { getLogger } from '../logger';
const logger = getLogger('SessionsCommand');

const sessionsMatchRegex = /^!sessions/i;

export function listenForStaffSessions() {
  IRCClient.addMessageHookInChannel(IRCClient.staffSupportChan, sessionsMatchRegex, async (event) => {
    logger.debug(`Staff sessions request from nick ${event.nick}`);
    const activeSessions = Object.values(SupportSessionManager.activeSupportSessions).filter((sess) => !sess.ended);
    if (!activeSessions.length) {
      event.reply('No active sessions');
    } else {
      activeSessions.forEach((sess) => {
        event.reply(`${sess.ircChannel} - ${spaceNick(sess.staffHandlerNick)} helping ${spaceNick(sess.userClientNick)}`);
      });
    }
  });
}
