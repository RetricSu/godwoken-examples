import { generateGodwokenConfig } from './util';

const run = async() => {
    // generate config file from config.toml
    await generateGodwokenConfig('../configs/config.toml', 
                                 '../configs/godwoken_config.json');
}

run();