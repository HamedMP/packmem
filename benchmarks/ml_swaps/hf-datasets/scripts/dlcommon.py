from torch.utils.data import Dataset


class Holder(Dataset):
    def __init__(self, x):
        self.x = x

    def __len__(self):
        return len(self.x)

    def __getitem__(self, i):
        return self.x[i]
