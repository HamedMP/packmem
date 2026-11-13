import sys, types

def load_train_module():
    """Import llava.train.train without deepspeed, the model zoo, or the trainer.

    Only LazySupervisedDataset is exercised, which needs none of them.
    """
    ds = types.ModuleType("deepspeed")
    sys.modules["deepspeed"] = ds
    model = types.ModuleType("llava.model")
    model.LlavaLlamaForCausalLM = object
    model.__all__ = []
    sys.modules["llava.model"] = model
    trainer = types.ModuleType("llava.train.llava_trainer")
    trainer.LLaVATrainer = object
    sys.modules["llava.train.llava_trainer"] = trainer
    import llava.train.train as t
    return t
