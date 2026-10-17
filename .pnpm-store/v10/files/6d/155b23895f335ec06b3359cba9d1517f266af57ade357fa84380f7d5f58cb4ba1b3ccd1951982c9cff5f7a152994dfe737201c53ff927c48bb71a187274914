import pg from 'pg';
import { PostgresOptions } from './types.js';
/**
 * This class creates an instance from which a single Postgres cluster is
 * managed. Note that many clusters may be created, but they will need seperate
 * data directories in order to be properly lifecycle managed.
 */
declare class EmbeddedPostgres {
    protected options: PostgresOptions;
    private process?;
    private isRootUser;
    constructor(options?: Partial<PostgresOptions>);
    /**
     * This function needs to be called whenever a Postgres cluster first needs
     * to be created. It will populate the data directory with the right
     * settings. If your Postgres cluster is already initialised, you don't need
     * to call this function again.
     */
    initialise(): Promise<void>;
    /**
     * Start the Postgres cluster with the given configuration. The cluster is
     * started as a seperate process, unmanaged by NodeJS. It is automatically
     * shut down when the script exits.
     */
    start(): Promise<void>;
    /**
     * Stop an already started cluster with the given configuration.
     * NOTE: If you have `persisent` set to false, this method WILL DELETE your
     * database files. You will need to call `.initialise()` again after executing
     * this method.
     */
    stop(): Promise<void>;
    /**
     * Create a node-postgres client using the existing cluster configuration.
     *
     * @param database The database that the postgres client should connect to
     * @param host The host that should be pre-filled in the connection options
     * @returns Client
     */
    getPgClient(database?: string, host?: string): pg.Client;
    /**
     * Create a database with a given name on the cluster
     */
    createDatabase(name: string): Promise<void>;
    /**
     * Drop a database with a given name on the cluster
     */
    dropDatabase(name: string): Promise<void>;
    /**
     * Warn the user in case they're trying to run this library as a root user
     */
    private checkForRootUser;
    /**
     * Retrieve the uid and gid for a particular user
     */
    private getUidAndGid;
}
export default EmbeddedPostgres;
