/** 只复用原运行时通知历史与持久化入口，不建立第二份队列。 */
export type Entry1 = typeof import("./../background-notification-history.js");
