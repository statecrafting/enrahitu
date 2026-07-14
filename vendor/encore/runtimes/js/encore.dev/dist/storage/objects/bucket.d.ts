/// <reference types="node" />
import * as runtime from "../../internal/runtime/mod.js";
import { StringLiteral } from "../../internal/utils/constraints.js";
import { BucketPerms, Uploader, SignedUploader, Downloader, SignedDownloader, Attrser, Lister, Remover, PublicUrler } from "./refs.js";
/**
 * Configuration options for declaring a Bucket.
 */
export interface BucketConfig {
    /**
     * Whether the objects in the bucket should be publicly
     * accessible, via CDN. Defaults to false if unset.
    */
    public?: boolean;
    /**
     * Whether to enable versioning of the objects in the bucket.
     * Defaults to false if unset.
     */
    versioned?: boolean;
}
/**
 * Defines a new Object Storage bucket infrastructure resource.
 */
export declare class Bucket extends BucketPerms implements Uploader, SignedUploader, Downloader, SignedDownloader, Attrser, Lister, Remover, PublicUrler {
    impl: runtime.Bucket;
    /**
     * Creates a new bucket with the given name and configuration
     */
    constructor(name: string, cfg?: BucketConfig);
    /**
     * Reference an existing bucket by name.
     * To create a new storage bucket, use `new StorageBucket(...)` instead.
     */
    static named<name extends string>(name: StringLiteral<name>): Bucket;
    list(options: ListOptions): AsyncGenerator<ListEntry>;
    /**
     * Returns whether the object exists in the bucket.
     * Throws an error on network failure.
     */
    exists(name: string, options?: ExistsOptions): Promise<boolean>;
    /**
     * Returns the object's attributes.
     * Throws an error if the object does not exist.
     */
    attrs(name: string, options?: AttrsOptions): Promise<ObjectAttrs>;
    /**
     * Uploads an object to the bucket.
     */
    upload(name: string, data: Buffer, options?: UploadOptions): Promise<ObjectAttrs>;
    /**
     * Generate an external URL to allow uploading an object to the bucket.
     *
     * Anyone with possession of the URL can write to the given object name
     * without any additional auth.
     */
    signedUploadUrl(name: string, options?: UploadUrlOptions): Promise<SignedUploadUrl>;
    /**
     * Generate an external URL to allow downloading an object from the bucket.
     *
     * Anyone with possession of the URL can download the given object without
     * any additional auth.
     */
    signedDownloadUrl(name: string, options?: DownloadUrlOptions): Promise<SignedDownloadUrl>;
    /**
     * Downloads an object from the bucket and returns its contents.
     */
    download(name: string, options?: DownloadOptions): Promise<Buffer>;
    /**
     * Removes an object from the bucket.
     * Throws an error on network failure.
     */
    remove(name: string, options?: DeleteOptions): Promise<void>;
    /**
    * Returns the public URL for accessing the object with the given name.
    * Throws an error if the bucket is not public.
    */
    publicUrl(name: string): string;
    ref<P extends BucketPerms>(): P;
}
/**
 * Options for listing objects in a bucket.
 */
export interface ListOptions {
    /**
     * Only include objects with this prefix in the listing.
     * If unset, all objects are included.
    */
    prefix?: string;
    /** Maximum number of objects to return. Defaults to no limit. */
    limit?: number;
}
/**
 * Options for retrieving the attributes of an object.
 */
export interface AttrsOptions {
    /**
     * The object version to retrieve attributes for.
     * Defaults to the lastest version if unset.
     *
     * If bucket versioning is not enabled, this option is ignored.
     */
    version?: string;
}
/**
 * Options for checking the existence of an object.
 */
export interface ExistsOptions {
    /**
     * The object version to check for existence.
     * Defaults to the lastest version if unset.
     *
     * If bucket versioning is not enabled, this option is ignored.
     */
    version?: string;
}
/**
 * Options for deleting an object from a bucket.
 */
export interface DeleteOptions {
    /**
     * The object version to delete.
     * Defaults to the lastest version if unset.
     *
     * If bucket versioning is not enabled, this option is ignored.
     */
    version?: string;
}
/**
 * Options for downloading an object from a bucket.
 */
export interface DownloadOptions {
    /**
     * The object version to download.
     * Defaults to the lastest version if unset.
     *
     * If bucket versioning is not enabled, this option is ignored.
     */
    version?: string;
}
/**
 * Describes the attributes of an object stored in a bucket.
 */
export interface ObjectAttrs {
    name: string;
    size: number;
    /** The version of the object, if bucket versioning is enabled. */
    version?: string;
    etag: string;
    contentType?: string;
}
/**
 * A single entry returned when listing objects in a bucket.
 */
export interface ListEntry {
    name: string;
    size: number;
    etag: string;
}
/**
 * Options for uploading an object to a bucket.
 */
export interface UploadOptions {
    contentType?: string;
    preconditions?: {
        notExists?: boolean;
    };
}
/**
 * Options for generating a signed upload URL.
 */
export interface UploadUrlOptions {
    /** The expiration time of the url, in seconds from signing. The maximum
     * value is seven days. If no value is given, a default of one hour is
     * used. */
    ttl?: number;
}
/**
 * A signed URL that allows uploading an object without additional auth.
 */
export interface SignedUploadUrl {
    url: string;
}
/**
 * Options for generating a signed download URL.
 */
export interface DownloadUrlOptions {
    /** The expiration time of the url, in seconds from signing. The maximum
     * value is seven days. If no value is given, a default of one hour is
     * used. */
    ttl?: number;
}
/**
 * A signed URL that allows downloading an object without additional auth.
 */
export interface SignedDownloadUrl {
    url: string;
}
