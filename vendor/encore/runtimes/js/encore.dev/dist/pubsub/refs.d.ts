export declare abstract class TopicPerms {
    private topicPerms;
}
export declare abstract class Publisher<Msg extends object> extends TopicPerms {
    abstract publish(msg: Msg): Promise<string>;
}
