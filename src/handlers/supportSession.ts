import path from 'path';
import { mkdirSync, lstatSync, promises } from 'fs';
import crypto from 'crypto';
import { LevelDB } from '../clients/leveldb';
import { Config } from '../clients/config';
import { IRCClient } from '../clients/irc';
import { ABClient } from '../clients/animebytes';
import { SupportQueue } from './supportQueue';
import { listenForStaffReenableInChannel } from '../commands/reenable';
import { getIRCColorFunc, randomIRCColor, spaceNick } from '../utils';
import { getLogger } from '../logger';
const logger = getLogger('SupportSession');

const logsDir = Config.getConfig().logs_dir || 'logs';
// Make sure logs dir exists
try {
  mkdirSync(logsDir, { recursive: true });
} catch (e) {
  // Ignore error if it is already existing and is a directory
  if (e.code !== 'EEXIST') throw e;
  if (!lstatSync(logsDir).isDirectory()) throw new Error(`Logs directory '${logsDir}' already exists but is not a directory!`);
}

export class SupportSession {
  public static logsDir = logsDir; // copied as a static var for testing purposes
  public ircChannel: string;
  public staffHandlerNick: string;
  public userClientNick: string;
  public reason: string;
  public log: string[];
  public startTime: string;
  public color: string;
  public cleanupCallbacks: Set<() => any>;
  public ended: boolean;
  public started: boolean;

  public static newSession(channel: string, staffNick: string, userNick: string, reason: string, removalCallback: () => any) {
    const session = new SupportSession();
    session.ircChannel = channel;
    session.staffHandlerNick = staffNick;
    session.userClientNick = userNick;
    session.reason = reason;
    session.log = [];
    session.startTime = new Date().toISOString();
    session.color = randomIRCColor();
    session.cleanupCallbacks = new Set([removalCallback]);
    session.ended = false;
    session.started = false;
    session.setUpIRCCallbacks();
    return session;
  }

  public static async fromState(stateJSON: any, removalCallback: () => any) {
    const session = new SupportSession();
    session.ircChannel = stateJSON.chan;
    session.staffHandlerNick = stateJSON.staff;
    session.userClientNick = stateJSON.user;
    session.reason = stateJSON.reason;
    session.color = stateJSON.color;
    session.log = stateJSON.log;
    session.startTime = stateJSON.time;
    session.cleanupCallbacks = new Set([removalCallback]);
    session.ended = false;
    session.started = true; // if loading from state, it is assumed to already be started
    session.setUpIRCCallbacks();
    if (IRCClient.joined) await session.logMsg('--- Reconnected to IRC ---');
    return session;
  }

  private setUpIRCCallbacks() {
    const msgHandler = async (event: any) => await this.logMsg(`${event.nick}: ${event.message}`);
    const disconnectHandler = async () => await this.logMsg('--- Disconnected from IRC ---');
    const connectHandler = async () => {
      await this.logMsg('--- Reconnected to IRC ---');
      await this.checkIfInProgress();
    };
    const joinHandler = async (nick: string, chan: string) => {
      if (chan.toLowerCase() === this.ircChannel.toLowerCase()) await this.logMsg(`${nick} has joined.`);
    };
    const renameHandler = async (oldNick: string, newNick: string) => {
      let changed = false;
      if (this.staffHandlerNick.toLowerCase() === oldNick.toLowerCase()) {
        this.staffHandlerNick = newNick;
        changed = true;
      }
      if (this.userClientNick.toLowerCase() === oldNick.toLowerCase()) {
        this.userClientNick = newNick;
        changed = true;
      }
      if (changed) {
        // Note this log also saves the entire session including updated nicks to state
        await this.logMsg(`${oldNick} has changed their nick to ${newNick}.`);
      }
    };
    const leaveHandler = async (nick: string, chan: string, leaveType: string) => {
      if (chan.toLowerCase() === this.ircChannel.toLowerCase()) {
        await this.logMsg(`${nick} has left (${leaveType}).`);
        await this.checkIfInProgress();
      }
    };
    this.cleanupCallbacks.add(listenForStaffReenableInChannel(this.ircChannel));
    this.cleanupCallbacks.add(IRCClient.addMessageHookInChannel(this.ircChannel, /.*/, msgHandler.bind(this)));
    this.cleanupCallbacks.add(IRCClient.addConnectHandler(connectHandler.bind(this)));
    this.cleanupCallbacks.add(IRCClient.addDisconnectHandler(disconnectHandler.bind(this)));
    this.cleanupCallbacks.add(IRCClient.addUserJoinHandler(joinHandler.bind(this)));
    this.cleanupCallbacks.add(IRCClient.addUserLeaveHandler(leaveHandler.bind(this)));
    this.cleanupCallbacks.add(IRCClient.addUserRenameHandler(renameHandler.bind(this)));
  }

  public async startNewSession(userIP: string, announce: boolean) {
    try {
      // Make sure this channel is empty before starting
      for (const nick of IRCClient.channelState[this.ircChannel.toLowerCase()] || new Set()) {
        if (!IRCClient.isMe(nick)) IRCClient.kickUserFromChannel(this.ircChannel, nick);
      }
      // Send announcement/notice
      if (announce)
        IRCClient.message(
          IRCClient.userSupportChan,
          `Now helping ${this.userClientNick}.${SupportQueue.queue.length ? ` Next in queue: ${SupportQueue.queue[0].nick}` : ''}`
        );
      IRCClient.notice(this.staffHandlerNick, `Starting support session for ${this.userClientNick} in ${this.ircChannel}, user IP: ${userIP}`);
      // Remove the user to help from the main support channel
      IRCClient.kickUserFromChannel(IRCClient.userSupportChan, this.userClientNick);
      // Start log. Note this also saves this session to state
      await this.logMsg(
        `Beginning support conversation between ${this.userClientNick} and ${this.staffHandlerNick} in ${this.ircChannel}. Reason: ${this.reason}`
      );
      // Join the staff and user to the session channel
      await IRCClient.joinUserToChannel(this.ircChannel, this.staffHandlerNick);
      await IRCClient.joinUserToChannel(this.ircChannel, this.userClientNick);
      IRCClient.notice(this.userClientNick, `${this.userClientNick}, you are now being helped by ${this.staffHandlerNick} in ${this.ircChannel}`);
      this.started = true;
    } catch (e) {
      logger.error(`Unexpected error starting new support session: ${e}`);
      throw new Error('Internal Error');
    }
  }

  public async logMsg(msg: string) {
    this.log.push(
      `${new Date()
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z/, ' UTC')} | ${msg}`
    );
    try {
      IRCClient.message(
        IRCClient.supportLogChan,
        `${getIRCColorFunc(this.color)(this.ircChannel)} - ${msg
          .replace(new RegExp(this.userClientNick, 'gi'), spaceNick(this.userClientNick))
          .replace(new RegExp(this.staffHandlerNick, 'gi'), spaceNick(this.staffHandlerNick))}`
      );
    } catch (e) {
      logger.warn('Unable to send message to log channel');
    }
    await this.saveToState();
  }

  public async checkIfInProgress() {
    const users = IRCClient.channelState[this.ircChannel.toLowerCase()] || new Set();
    // If the assigned staff or user aren't in the support session channel, this session is ended;
    if (!users.has(this.staffHandlerNick.toLowerCase()) || !users.has(this.userClientNick.toLowerCase())) await this.endSession();
  }

  public async endSession() {
    if (!this.ended) {
      if (this.started) {
        // Create the serialized log
        const logStr = this.log.join('\n');
        const logName = `${this.ircChannel} ${new Date().toISOString()} ${this.userClientNick} ${this.staffHandlerNick}.log`;
        const logPath = path.join(SupportSession.logsDir, logName);
        // Save the log to disk
        try {
          await promises.writeFile(logPath, logStr, 'utf8');
        } catch (e) {
          logger.error(`Unexpected error writing log file '${logPath}': ${e}`);
        }
        // Upload the log as a paste
        let pasteURL = '';
        try {
          pasteURL = await ABClient.createPaste(
            logName,
            logStr,
            crypto
              .randomBytes(32)
              .toString('base64')
              .replace(/\/|\+|=/g, '')
              .substring(0, 16)
          );
        } catch (e) {
          logger.error(`Error uploading logs to AB: ${e}`);
        }
        // Send completion message to log channel
        try {
          IRCClient.message(
            IRCClient.supportLogChan,
            `Support conversation in ${this.ircChannel} between ${spaceNick(this.userClientNick)} and ${spaceNick(this.staffHandlerNick)} complete. ${
              pasteURL ? `A log can be found at ${pasteURL}` : 'I could not properly upload the logs, but they should be saved locally.'
            }`
          );
        } catch (e) {
          logger.error(`Error sending message to log channel: ${e}`);
        }
      }
      // Kick users from the session channel
      for (const nick of IRCClient.channelState[this.ircChannel.toLowerCase()] || new Set()) {
        if (!IRCClient.isMe(nick)) IRCClient.kickUserFromChannel(this.ircChannel, nick);
      }
      // Call all of the cleanup callbacks
      for (const cb of this.cleanupCallbacks) {
        try {
          await cb();
        } catch (e) {
          logger.error(`Exception when calling session cleanup callback: ${e}`);
        }
      }
      // Remove this session from state
      try {
        await LevelDB.delete(this.dbKey());
      } catch (e) {
        logger.error(`Failed to remove session from state: ${e}`);
      }
      logger.info(`Support session for ${this.userClientNick} with ${this.staffHandlerNick} in ${this.ircChannel} has ended`);
    }
    this.ended = true;
  }

  public async saveToState() {
    await LevelDB.put(this.dbKey(), {
      chan: this.ircChannel,
      staff: this.staffHandlerNick,
      user: this.userClientNick,
      reason: this.reason,
      time: this.startTime,
      color: this.color,
      log: this.log,
    });
  }

  public dbKey() {
    return `session::${this.ircChannel}`;
  }
}
